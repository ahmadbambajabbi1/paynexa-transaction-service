import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { RabbitmqService } from './infrastructure/rabbitmq/rabbitmq.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: PrismaService, useValue: {} },
        {
          provide: RabbitmqService,
          useValue: { publish: jest.fn(), consume: jest.fn() },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health', () => {
    it('should return service status', () => {
      expect(appController.health()).toEqual({
        service: 'transaction-service',
        status: 'ok',
      });
    });
  });
});
