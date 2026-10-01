import { Global, Module } from '@nestjs/common';
import { InstitutionBrandService } from './institution-brand.service';

@Global()
@Module({
  providers: [InstitutionBrandService],
  exports: [InstitutionBrandService],
})
export class InstitutionModule {}
