import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Request body used to add a markdown response. An owner response may also
 * reopen the owner's closed ticket.
 */
export class CreateResponseDto {
  @ApiProperty({
    description: 'Markdown response body.',
    maxLength: 50000,
  })
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  markdown!: string;
}
