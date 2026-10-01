import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { InstallmentsService } from './installments.service';

class IgnoreInstallmentDto {
  @IsString()
  @MinLength(1)
  key!: string;
}

@Controller('installments')
export class InstallmentsController {
  constructor(private readonly installments: InstallmentsService) {}

  @Get('overview')
  getOverview(@Query('month') month?: string) {
    return this.installments.getOverview(month);
  }

  @Post('ignore')
  ignore(@Body() body: IgnoreInstallmentDto) {
    return this.installments.ignorePurchase(body.key);
  }

  @Delete('ignore')
  unignore(@Query('key') key?: string) {
    return this.installments.unignorePurchase(key ?? '');
  }
}
