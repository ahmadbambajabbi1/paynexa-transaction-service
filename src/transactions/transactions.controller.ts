import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  MessageEvent,
  Param,
  Patch,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ActorDto } from '../dto/actor.dto';
import { AddDocumentDto } from '../dto/add-document.dto';
import { AgreementDto } from '../dto/agreement.dto';
import { CreatePublicTransactionDto, CreateTransactionDto } from '../dto/create-transaction.dto';
import { DisputeDto } from '../dto/dispute.dto';
import { InviteParticipantDto } from '../dto/invite-participant.dto';
import { ParticipantRoleDto } from '../dto/participant-role.dto';
import { UpdateStateDto } from '../dto/update-state.dto';
import { TransactionsService } from './transactions.service';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get()
  health(): { service: string; status: string } {
    return { service: 'transaction-service', status: 'ok' };
  }

  @Get('counterparty-search')
  searchCounterparty(@Query('query') query?: string) {
    return this.transactions.searchCounterparty(query);
  }

  @Get(':id/participants/search')
  searchParticipants(
    @Param('id') id: string,
    @Query('role') role?: string,
    @Query('query') query?: string,
    @Query('partySide') partySide?: string,
  ) {
    return this.transactions.searchTransactionParticipants(
      id,
      role,
      query,
      partySide,
    );
  }

  @Get('notifications')
  notifications(@Query('userId') userId?: string) {
    return this.transactions.listNotifications(userId);
  }

  @Patch('notifications/:id/read')
  markNotificationRead(@Param('id') id: string) {
    return this.transactions.markNotificationRead(id);
  }

  @Sse('notifications/stream')
  streamNotifications(@Query('userId') userId?: string): Observable<MessageEvent> {
    if (!userId) {
      throw new BadRequestException('userId query required');
    }
    return this.transactions.notificationsStream(userId);
  }

  @Get('public/:id')
  async getPublicSummary(
    @Param('id') id: string,
    @Headers('x-device-id') deviceId?: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('authorization') authorization?: string,
  ): Promise<Record<string, unknown>> {
    const viewerUserId = await this.transactions.resolveOptionalViewerId(
      authorization,
      deviceId,
    );
    return this.transactions.getPublicTransactionSummary(id, {
      deviceId,
      userAgent,
      viewerUserId,
    });
  }

  @Get('by-party')
  listByParty(
    @Query('buyerId') buyerId?: string,
    @Query('sellerId') sellerId?: string,
  ): Promise<Record<string, unknown>> {
    return this.transactions.listTransactionsForParty(buyerId, sellerId);
  }

  @Get(':id/room')
  getRoom(@Param('id') id: string): Promise<Record<string, unknown>> {
    return this.transactions.getTransactionRoom(id);
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<Record<string, unknown>> {
    return this.transactions.getTransactionRoom(id);
  }

  @Post()
  create(@Body() dto: CreateTransactionDto): Promise<Record<string, unknown>> {
    return this.transactions.createTransaction(dto);
  }

  @Post('escrow')
  createEscrow(@Body() dto: CreateTransactionDto): Promise<Record<string, unknown>> {
    return this.transactions.createEscrowTransaction(dto);
  }

  @Post('public')
  createPublic(@Body() dto: CreatePublicTransactionDto): Promise<Record<string, unknown>> {
    return this.transactions.createPublicTransaction(dto);
  }

  @Patch('public/:id/claim')
  claimPublic(
    @Param('id') id: string,
    @Body() dto: ActorDto,
    @Headers('x-device-id') deviceId?: string,
  ): Promise<Record<string, unknown>> {
    return this.transactions.claimPublicTransaction(id, dto.actorId, deviceId);
  }

  @Patch(':id/accept')
  accept(
    @Param('id') id: string,
    @Body() dto: ActorDto,
  ): Promise<Record<string, unknown>> {
    return this.transactions.acceptTransaction(id, dto.actorId);
  }

  @Patch(':id/state')
  updateState(
    @Param('id') id: string,
    @Body() dto: UpdateStateDto,
  ): Promise<Record<string, unknown>> {
    return this.transactions.updateState(id, dto.newState, dto.actorId);
  }

  @Patch(':id/mark-wallet-funded')
  markWalletFunded(
    @Param('id') id: string,
    @Body() dto: ActorDto,
    @Headers('x-internal-secret') internalSecret?: string,
  ): Promise<Record<string, unknown>> {
    this.transactions.verifyInternalApiSecret(internalSecret);
    return this.transactions.markWalletPaymentFunded(id, dto.actorId);
  }

  @Patch(':id/invite-participant')
  inviteParticipant(
    @Param('id') id: string,
    @Body() dto: InviteParticipantDto,
  ): Promise<Record<string, unknown>> {
    return this.transactions.inviteParticipant(
      id,
      dto.actorId,
      dto.participantUserId,
      dto.role,
      dto.partySide,
      dto.message,
    );
  }

  @Patch(':id/participant-accept')
  acceptParticipant(
    @Param('id') id: string,
    @Body() dto: ParticipantRoleDto,
  ): Promise<Record<string, unknown>> {
    return this.transactions.acceptParticipantInvite(
      id,
      dto.actorId,
      dto.role,
      dto.partySide,
    );
  }

  @Post(':id/agreement')
  versionAgreement(
    @Param('id') id: string,
    @Body() dto: AgreementDto,
  ): Promise<Record<string, unknown>> {
    return this.transactions.versionAgreement(id, dto.content, dto.actorId);
  }

  @Post(':id/documents')
  addDocument(
    @Param('id') id: string,
    @Body() dto: AddDocumentDto,
  ): Promise<Record<string, unknown>> {
    return this.transactions.addDocument(id, dto);
  }

  @Post(':id/dispute')
  dispute(
    @Param('id') id: string,
    @Body() dto: DisputeDto,
  ): Promise<Record<string, unknown>> {
    return this.transactions.raiseDispute(id, dto.actorId, dto.reason);
  }
}
