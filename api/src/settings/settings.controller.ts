import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SettingsService } from './settings.service';
import type { AccountMapTargetType } from './settings.types';

class AccountMapDto {
  @IsString()
  pluggyAccountId!: string;

  @IsIn(['account', 'credit_card', 'ignored'])
  targetType!: AccountMapTargetType;

  @IsNumber()
  organizzeTargetId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  nickname?: string | null;

  @IsOptional()
  cardNicknames?: Record<string, string> | null;
}

class UpdateSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(50)
  amountTolerancePercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(30)
  dateToleranceDays?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AccountMapDto)
  accountMaps?: AccountMapDto[];
}

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  getSettings() {
    return this.settings.getSettings();
  }

  @Put()
  updateSettings(@Body() body: UpdateSettingsDto) {
    return this.settings.updateSettings(body);
  }
}
