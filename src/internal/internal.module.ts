import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { InternalAdminController } from './internal-admin.controller';

@Module({
  imports: [AdminModule],
  controllers: [InternalAdminController],
})
export class InternalModule {}
