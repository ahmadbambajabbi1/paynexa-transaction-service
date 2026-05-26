import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { connect } from 'amqplib';
import { randomUUID } from 'crypto';

export const SAFETRADE_EXCHANGE = 'safetrade.events';

@Injectable()
export class RabbitmqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitmqService.name);
  private connection?: ChannelModel;
  private channel?: Channel;
  private initPromise?: Promise<void>;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.initPromise = this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.warn('RABBITMQ_URL not set; event publishing/consuming is disabled');
      return;
    }
    try {
      this.connection = await connect(url);
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(SAFETRADE_EXCHANGE, 'topic', {
        durable: true,
      });
      this.logger.log('Connected to RabbitMQ');
    } catch (error) {
      this.logger.error('Failed to connect to RabbitMQ', error as Error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  async publish(routingKey: string, payload: unknown): Promise<void> {
    if (this.initPromise) await this.initPromise;
    if (!this.channel) {
      this.logger.warn(`RabbitMQ channel not ready; skipping publish: ${routingKey}`);
      return;
    }
    try {
      this.channel.publish(
        SAFETRADE_EXCHANGE,
        routingKey,
        Buffer.from(JSON.stringify(payload)),
        { persistent: true, contentType: 'application/json' },
      );
      this.logger.log(`Published: ${routingKey}`);
    } catch (error) {
      this.logger.error(`Failed to publish ${routingKey}`, error as Error);
    }
  }

  async consume(
    queue: string,
    routingKeys: string[],
    handler: (routingKey: string, body: unknown) => Promise<void>,
  ): Promise<void> {
    if (this.initPromise) await this.initPromise;
    if (!this.channel) {
      this.logger.warn(`RabbitMQ channel not ready; skipping consume: ${queue}`);
      return;
    }
    await this.channel.assertQueue(queue, { durable: true });
    for (const key of routingKeys) {
      await this.channel.bindQueue(queue, SAFETRADE_EXCHANGE, key);
    }
    this.logger.log(`Consuming queue ${queue} for keys: ${routingKeys.join(', ')}`);
    await this.channel.consume(queue, (msg: ConsumeMessage | null) => {
      void this.handleMessage(msg, handler);
    });
  }

  private async handleMessage(
    msg: ConsumeMessage | null,
    handler: (routingKey: string, body: unknown) => Promise<void>,
  ): Promise<void> {
    if (!msg || !this.channel) return;
    try {
      const body = JSON.parse(msg.content.toString()) as unknown;
      await handler(msg.fields.routingKey, body);
      this.channel.ack(msg);
    } catch (error) {
      this.logger.error('Consumer error', error as Error);
      this.channel.nack(msg, false, true);
    }
  }

  async rpc<T = unknown>(
    routingKey: string,
    payload: unknown,
    timeoutMs = 15_000,
  ): Promise<T> {
    if (this.initPromise) await this.initPromise;
    if (!this.channel) {
      throw new Error(`RabbitMQ not connected; cannot call RPC ${routingKey}`);
    }
    const ch = this.channel;
    const correlationId = randomUUID();
    const { queue: replyTo } = await ch.assertQueue('', {
      exclusive: true,
      autoDelete: true,
    });
    return new Promise<T>((resolve, reject) => {
      let consumerTag: string | undefined;
      const cleanup = () => {
        if (consumerTag) {
          ch.cancel(consumerTag).catch(() => undefined);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`RPC timeout: ${routingKey}`));
      }, timeoutMs);
      void ch
        .consume(
          replyTo,
          (msg) => {
            if (!msg || msg.properties.correlationId !== correlationId) return;
            clearTimeout(timer);
            cleanup();
            ch.ack(msg);
            try {
              const body = JSON.parse(msg.content.toString()) as {
                error?: string;
                data?: T;
              };
              if (body.error) {
                reject(new Error(body.error));
              } else {
                resolve(body.data as T);
              }
            } catch (e) {
              reject(e as Error);
            }
          },
          { noAck: false },
        )
        .then((result) => {
          consumerTag = result.consumerTag;
        })
        .catch(reject);
      ch.publish(
        SAFETRADE_EXCHANGE,
        routingKey,
        Buffer.from(JSON.stringify(payload)),
        {
          correlationId,
          replyTo,
          contentType: 'application/json',
          persistent: false,
        },
      );
    });
  }

  async consumeRpc(
    queue: string,
    routingKeys: string[],
    handler: (routingKey: string, body: unknown) => Promise<unknown>,
  ): Promise<void> {
    if (this.initPromise) await this.initPromise;
    if (!this.channel) {
      this.logger.warn(`RabbitMQ not ready; skipping consumeRpc: ${queue}`);
      return;
    }
    await this.channel.assertQueue(queue, { durable: true });
    for (const key of routingKeys) {
      await this.channel.bindQueue(queue, SAFETRADE_EXCHANGE, key);
    }
    this.logger.log(`RPC listening on queue ${queue}`);
    await this.channel.consume(queue, async (msg) => {
      if (!msg || !this.channel) return;
      const { replyTo, correlationId } = msg.properties as {
        replyTo?: string;
        correlationId?: string;
      };
      try {
        const body = JSON.parse(msg.content.toString()) as unknown;
        const result = await handler(msg.fields.routingKey, body);
        if (replyTo && correlationId) {
          this.channel.sendToQueue(
            replyTo,
            Buffer.from(JSON.stringify({ data: result })),
            { correlationId, contentType: 'application/json' },
          );
        }
        this.channel.ack(msg);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`RPC handler error on ${queue}: ${errMsg}`);
        if (replyTo && correlationId) {
          this.channel.sendToQueue(
            replyTo,
            Buffer.from(JSON.stringify({ error: errMsg })),
            { correlationId, contentType: 'application/json' },
          );
        }
        this.channel.ack(msg);
      }
    });
  }
}
