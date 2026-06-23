import { Injectable, Logger } from '@nestjs/common';
import twilio from 'twilio';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  async sendTransactionInviteSms(
    toPhone: string,
    payload: { transactionId: string; productTitle: string; role: string },
  ): Promise<void> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
    const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
    const from =
      process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() ??
      process.env.TWILIO_FROM_NUMBER?.trim();
    if (!accountSid || !authToken || !from) {
      this.logger.warn('Twilio SMS config missing; skipping transaction invite SMS.');
      return;
    }
    const client = twilio(accountSid, authToken);
    await client.messages.create({
      to: toPhone,
      from,
      body:
        `PayNexa invitation: You were invited as ${payload.role} ` +
        `for "${payload.productTitle}". Transaction ID: ${payload.transactionId}.`,
    });
  }
}
