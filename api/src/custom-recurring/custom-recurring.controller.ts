import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CustomRecurringService } from './custom-recurring.service';

class PreviewDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endDate!: string;

  @IsIn(['DAY', 'WEEK', 'MONTH'])
  intervalUnit!: 'DAY' | 'WEEK' | 'MONTH';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  intervalCount!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountCents!: number;

  @IsIn(['EXPENSE', 'INCOME'])
  kind!: 'EXPENSE' | 'INCOME';
}

class CreateDto extends PreviewDto {
  @IsString()
  @MaxLength(200)
  description!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  accountId!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];
}

class UpdateDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endDate!: string;
}

@Controller('custom-recurring')
export class CustomRecurringController {
  constructor(private readonly recurring: CustomRecurringService) {}

  @Get()
  list() {
    return this.recurring.list();
  }

  @Post('preview')
  preview(@Body() body: PreviewDto) {
    return this.recurring.preview(body);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.recurring.get(id);
  }

  @Post()
  create(@Body() body: CreateDto) {
    return this.recurring.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: UpdateDto) {
    return this.recurring.update(id, body);
  }

  @Post(':id/retry')
  retry(@Param('id') id: string) {
    return this.recurring.retryFailed(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.recurring.remove(id);
  }
}
