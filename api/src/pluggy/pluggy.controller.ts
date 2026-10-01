import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { PluggyService } from './pluggy.service';

class ConnectTokenDto {
  @IsOptional()
  @IsString()
  itemId?: string;
}

class AddConnectionDto {
  @IsString()
  itemId!: string;

  @IsOptional()
  @IsString()
  customName?: string;

  @IsString()
  institutionName!: string;

  @IsString()
  institutionImageUrl!: string;

  @IsOptional()
  @IsString()
  institutionPrimaryColor?: string;
}

class UpdateConnectionDto {
  @IsOptional()
  @IsString()
  customName?: string | null;

  @IsOptional()
  @IsString()
  institutionName?: string | null;

  @IsOptional()
  @IsString()
  institutionImageUrl?: string | null;

  @IsOptional()
  @IsString()
  institutionPrimaryColor?: string | null;
}

@Controller('pluggy')
export class PluggyController {
  constructor(private readonly pluggy: PluggyService) {}

  @Post('connect-token')
  createConnectToken(@Body() body: ConnectTokenDto) {
    return this.pluggy.createConnectToken(body.itemId);
  }

  @Get('institutions')
  listInstitutions(@Query('q') q?: string) {
    return this.pluggy.listInstitutions(q);
  }

  @Get('connections/config')
  listConfiguredConnections() {
    return this.pluggy.listConfiguredConnections();
  }

  @Post('connections')
  addConnection(@Body() body: AddConnectionDto) {
    return this.pluggy.addConnection(body.itemId, {
      customName: body.customName,
      institutionName: body.institutionName,
      institutionImageUrl: body.institutionImageUrl,
      institutionPrimaryColor: body.institutionPrimaryColor,
    });
  }

  @Post('connections/sync')
  syncConnections() {
    return this.pluggy.syncAllConnections();
  }

  @Get('connections/sync-status')
  listConnectionSyncStatuses() {
    return this.pluggy.listConnectionSyncStatuses();
  }

  @Post('connections/:id/sync')
  syncConnection(@Param('id') id: string) {
    return this.pluggy.syncConnection(id);
  }

  @Patch('connections/:id')
  updateConnection(
    @Param('id') id: string,
    @Body() body: UpdateConnectionDto,
  ) {
    return this.pluggy.updateConnection(id, body);
  }

  @Delete('connections/:id')
  deleteConnection(@Param('id') id: string) {
    return this.pluggy.deleteConnection(id);
  }

  @Get('connections')
  listConnections() {
    return this.pluggy.listConnections();
  }

  @Get('accounts')
  listAccounts(@Query('itemId') itemId?: string) {
    return this.pluggy.listAccounts(itemId);
  }

  @Get('investments')
  listInvestments() {
    return this.pluggy.listInvestments();
  }

  @Get('transactions')
  listTransactions(
    @Query('accountId') accountId: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.pluggy.listTransactions({ accountId, dateFrom, dateTo });
  }
}
