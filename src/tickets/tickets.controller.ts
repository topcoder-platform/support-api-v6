import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthenticatedGuard } from '../auth/authenticated.guard';
import { CurrentActor } from '../auth/current-actor.decorator';
import { SupportActor } from '../auth/auth.types';
import {
  CreateResponseDto,
  CreateTicketDto,
  ListTicketsQueryDto,
  MarkReadResponseDto,
  TicketDetailDto,
  TicketPageDto,
} from './dto';
import { TicketsService } from './tickets.service';

/** Authenticated REST surface for member and Support Team ticket workflows. */
@ApiTags('Support tickets')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'A valid Topcoder user token is required.',
})
@Controller('tickets')
@UseGuards(AuthenticatedGuard)
export class TicketsController {
  /**
   * Creates the controller.
   *
   * @param tickets Ticket application service.
   */
  constructor(private readonly tickets: TicketsService) {}

  /**
   * Opens a support request owned by the authenticated user.
   *
   * @param actor Authenticated Topcoder user.
   * @param body Validated request content.
   * @returns The newly created ticket detail.
   */
  @Post()
  @ApiOperation({ summary: 'Open a support ticket' })
  @ApiCreatedResponse({ type: TicketDetailDto })
  async create(
    @CurrentActor() actor: SupportActor,
    @Body() body: CreateTicketDto,
  ): Promise<TicketDetailDto> {
    return this.tickets.create(actor, body);
  }

  /**
   * Lists tickets visible to the caller, with staff-only search filters.
   *
   * @param actor Authenticated Topcoder user.
   * @param query Validated pagination and filters.
   * @returns One authorized page of ticket summaries.
   */
  @Get()
  @ApiOperation({ summary: 'List visible support tickets' })
  @ApiOkResponse({ type: TicketPageDto })
  async list(
    @CurrentActor() actor: SupportActor,
    @Query() query: ListTicketsQueryDto,
  ): Promise<TicketPageDto> {
    return this.tickets.list(actor, query);
  }

  /**
   * Retrieves an authorized ticket and its chronological response timeline.
   *
   * @param actor Authenticated Topcoder user.
   * @param ticketId Ticket UUID.
   * @returns Full ticket detail.
   */
  @Get(':ticketId')
  @ApiOperation({ summary: 'Get a support ticket' })
  @ApiOkResponse({ type: TicketDetailDto })
  @ApiForbiddenResponse({ description: 'The caller cannot view this ticket.' })
  @ApiNotFoundResponse({ description: 'The ticket does not exist.' })
  async getById(
    @CurrentActor() actor: SupportActor,
    @Param('ticketId', new ParseUUIDPipe()) ticketId: string,
  ): Promise<TicketDetailDto> {
    return this.tickets.getById(actor, ticketId);
  }

  /**
   * Appends a markdown response. A ticket owner replying while closed reopens
   * the ticket; Support Team users may reply only while assigned to an open
   * ticket.
   *
   * @param actor Authenticated Topcoder user.
   * @param ticketId Ticket UUID.
   * @param body Validated response body.
   * @returns Updated ticket detail.
   */
  @Post(':ticketId/responses')
  @ApiOperation({
    summary: 'Reply to a support ticket, reopening it for the owner if closed',
  })
  @ApiCreatedResponse({ type: TicketDetailDto })
  @ApiConflictResponse({
    description:
      'A non-owner tried to reply while closed, or the ticket status changed concurrently.',
  })
  @ApiForbiddenResponse({
    description:
      'The caller cannot reply to this ticket or is an unassigned Support Team user.',
  })
  async addResponse(
    @CurrentActor() actor: SupportActor,
    @Param('ticketId', new ParseUUIDPipe()) ticketId: string,
    @Body() body: CreateResponseDto,
  ): Promise<TicketDetailDto> {
    return this.tickets.addResponse(actor, ticketId, body);
  }

  /**
   * Adds the authenticated Support Team user to an open ticket.
   *
   * @param actor Authenticated Topcoder support user.
   * @param ticketId Ticket UUID.
   * @returns Updated ticket detail.
   */
  @Post(':ticketId/assignees/me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign the current Support Team user' })
  @ApiOkResponse({ type: TicketDetailDto })
  @ApiForbiddenResponse({
    description: 'The caller is not on the Support Team.',
  })
  @ApiConflictResponse({ description: 'The ticket is already closed.' })
  async assignToMe(
    @CurrentActor() actor: SupportActor,
    @Param('ticketId', new ParseUUIDPipe()) ticketId: string,
  ): Promise<TicketDetailDto> {
    return this.tickets.assignToMe(actor, ticketId);
  }

  /**
   * Removes the authenticated Support Team user from a ticket.
   *
   * @param actor Authenticated Topcoder support user.
   * @param ticketId Ticket UUID.
   * @returns Updated ticket detail.
   */
  @Delete(':ticketId/assignees/me')
  @ApiOperation({ summary: 'Unassign the current Support Team user' })
  @ApiOkResponse({ type: TicketDetailDto })
  @ApiForbiddenResponse({
    description: 'The caller is not on the Support Team.',
  })
  async unassignMe(
    @CurrentActor() actor: SupportActor,
    @Param('ticketId', new ParseUUIDPipe()) ticketId: string,
  ): Promise<TicketDetailDto> {
    return this.tickets.unassignMe(actor, ticketId);
  }

  /**
   * Marks the ticket and every currently visible response as read by the caller.
   *
   * @param actor Authenticated Topcoder user.
   * @param ticketId Ticket UUID.
   * @returns The shared read timestamp written to all receipts.
   */
  @Post(':ticketId/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a ticket timeline as read' })
  @ApiOkResponse({ type: MarkReadResponseDto })
  @ApiForbiddenResponse({ description: 'The caller cannot view this ticket.' })
  async markRead(
    @CurrentActor() actor: SupportActor,
    @Param('ticketId', new ParseUUIDPipe()) ticketId: string,
  ): Promise<MarkReadResponseDto> {
    return this.tickets.markRead(actor, ticketId);
  }

  /**
   * Closes an open ticket assigned to the current Support Team user.
   *
   * @param actor Authenticated Topcoder support user.
   * @param ticketId Ticket UUID.
   * @returns Updated ticket detail. Repeated calls are idempotent.
   */
  @Post(':ticketId/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close a resolved support ticket' })
  @ApiOkResponse({ type: TicketDetailDto })
  @ApiForbiddenResponse({
    description:
      'The caller is not on the Support Team or is not assigned to the ticket.',
  })
  async close(
    @CurrentActor() actor: SupportActor,
    @Param('ticketId', new ParseUUIDPipe()) ticketId: string,
  ): Promise<TicketDetailDto> {
    return this.tickets.close(actor, ticketId);
  }
}
