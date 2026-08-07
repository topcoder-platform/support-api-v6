import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TicketStatus } from '@prisma/client';

/** User receipt proving that a ticket or response was read. */
export class ReadReceiptDto {
  @ApiProperty({ example: '123456' })
  userId!: string;

  @ApiProperty({ format: 'date-time' })
  readAt!: Date;
}

/** Staff assignment displayed on ticket lists and detail. */
export class TicketAssigneeDto {
  @ApiProperty({ example: '123456' })
  userId!: string;

  @ApiProperty({ example: 'helpful_staff' })
  handle!: string;

  @ApiPropertyOptional({ example: '#616BD5' })
  handleColor?: string;

  @ApiProperty({ format: 'date-time' })
  assignedAt!: Date;
}

/** One chronological reply in a support ticket. */
export class TicketMessageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '123456' })
  userId!: string;

  @ApiProperty({ example: 'helpful_staff' })
  userHandle!: string;

  @ApiPropertyOptional({ example: '#616BD5' })
  userHandleColor?: string;

  @ApiProperty({ description: 'Markdown response body.' })
  markdown!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: [ReadReceiptDto] })
  readBy!: ReadReceiptDto[];
}

/** Ticket fields optimized for open and closed list pages. */
export class TicketSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '123456' })
  memberUserId!: string;

  @ApiProperty({ example: 'member_handle' })
  memberHandle!: string;

  @ApiPropertyOptional({ example: '#2D7E2D' })
  memberHandleColor?: string;

  @ApiPropertyOptional()
  challengeId?: string;

  @ApiProperty({ description: 'Original markdown request.' })
  description!: string;

  @ApiProperty({ enum: TicketStatus })
  status!: TicketStatus;

  @ApiProperty({ format: 'date-time' })
  openedAt!: Date;

  @ApiPropertyOptional({ format: 'date-time' })
  closedAt?: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ format: 'date-time' })
  latestActivityAt!: Date;

  @ApiProperty({ minimum: 0 })
  responseCount!: number;

  @ApiProperty({ description: 'Unread state for the authenticated caller.' })
  hasUnread!: boolean;

  @ApiProperty({ type: [TicketAssigneeDto] })
  assignees!: TicketAssigneeDto[];
}

/** Full authorized ticket timeline and read state. */
export class TicketDetailDto extends TicketSummaryDto {
  @ApiProperty({ type: [ReadReceiptDto] })
  readBy!: ReadReceiptDto[];

  @ApiProperty({ type: [TicketMessageDto] })
  responses!: TicketMessageDto[];
}

/** Pagination metadata returned with ticket summaries. */
export class TicketPageMetaDto {
  @ApiProperty()
  page!: number;

  @ApiProperty()
  perPage!: number;

  @ApiProperty()
  totalCount!: number;

  @ApiProperty()
  totalPages!: number;
}

/** Paginated ticket list response. */
export class TicketPageDto {
  @ApiProperty({ type: [TicketSummaryDto] })
  data!: TicketSummaryDto[];

  @ApiProperty({ type: TicketPageMetaDto })
  meta!: TicketPageMetaDto;
}

/** Timestamp returned after explicit mark-read succeeds. */
export class MarkReadResponseDto {
  @ApiProperty({ format: 'date-time' })
  readAt!: Date;
}
