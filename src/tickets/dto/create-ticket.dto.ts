import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Request body used by an authenticated member to open a support ticket. */
export class CreateTicketDto {
  @ApiPropertyOptional({
    description: 'Optional v5 numeric or v6 UUID challenge identifier.',
    example: '9f20b3ef-b052-4a0f-bfec-9a92ff385b0b',
  })
  @IsOptional()
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  challengeId?: string;

  @ApiProperty({
    description: 'Markdown description of the support request.',
    maxLength: 50000,
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  description!: string;
}
