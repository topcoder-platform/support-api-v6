import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TicketStatus } from '@prisma/client';

/** Query parameters for a server-authorized page of support tickets. */
export class ListTicketsQueryDto {
  @ApiPropertyOptional({ enum: TicketStatus, default: TicketStatus.OPEN })
  @IsEnum(TicketStatus)
  status: TicketStatus = TicketStatus.OPEN;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage = 20;

  @ApiPropertyOptional({ description: 'Support Team exact handle filter.' })
  @IsOptional()
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsString()
  @MaxLength(100)
  memberHandle?: string;

  @ApiPropertyOptional({ description: 'Support Team challenge ID filter.' })
  @IsOptional()
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsString()
  @MaxLength(64)
  challengeId?: string;

  @ApiPropertyOptional({ description: 'Support Team description substring.' })
  @IsOptional()
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsString()
  @MaxLength(500)
  description?: string;
}
