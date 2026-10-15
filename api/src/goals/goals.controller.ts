import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GoalsService } from './goals.service';

class SettingsDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  minPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  primaryPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  idealPct?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  @Type(() => Number)
  investmentCategoryIds?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  estimatedUsdBrl?: number | null;
}

class CreateGoalDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetCents!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  allocatedCents?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  targetDate?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(9999)
  priority?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  monthlyContributionCents?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  monthlyContributionPct?: number | null;
}

class UpdateGoalDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetCents?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  targetDate?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(9999)
  priority?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  monthlyContributionCents?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  monthlyContributionPct?: number | null;

  @IsOptional()
  @IsIn(['ACTIVE', 'COMPLETED', 'PAUSED'])
  status?: 'ACTIVE' | 'COMPLETED' | 'PAUSED';
}

class AllocateDto {
  @Type(() => Number)
  @IsInt()
  amountCents!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}

@Controller('goals')
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get('overview')
  overview(@Query('month') month?: string) {
    return this.goals.overview(month);
  }

  @Get('settings')
  getSettings() {
    return this.goals.getSettings();
  }

  @Put('settings')
  updateSettings(@Body() body: SettingsDto) {
    return this.goals.updateSettings(body);
  }

  @Get()
  list() {
    return this.goals.listGoals();
  }

  @Post()
  create(@Body() body: CreateGoalDto) {
    return this.goals.createGoal(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: UpdateGoalDto) {
    return this.goals.updateGoal(id, body);
  }

  @Post(':id/allocate')
  allocate(@Param('id') id: string, @Body() body: AllocateDto) {
    return this.goals.allocate(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.goals.deleteGoal(id);
  }
}
