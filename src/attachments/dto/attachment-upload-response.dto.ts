import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Metadata returned after Filestack accepts a Support attachment upload. */
export class AttachmentUploadResponseDto {
  @ApiProperty({ example: 'screenshot.png' })
  filename!: string;

  @ApiProperty({ example: 's7tdGfE5RRKFUxwsZoYv' })
  handle!: string;

  @ApiPropertyOptional({
    example: 'a1RyBxiglW92bS2SRmqM_screenshot.png',
  })
  key?: string;

  @ApiPropertyOptional({ example: 'image/png' })
  mimetype?: string;

  @ApiPropertyOptional({ example: 8331, minimum: 1 })
  size?: number;

  @ApiProperty({
    example: 'https://cdn.filestackcontent.com/s7tdGfE5RRKFUxwsZoYv',
  })
  url!: string;
}
