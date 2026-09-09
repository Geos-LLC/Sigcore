import { Module } from '@nestjs/common';
import { CarrierLookupController } from './carrier-lookup.controller';
import { CarrierLookupService } from './carrier-lookup.service';

// SigcoreAuthGuard is Global (see SigcoreAuthModule) so no explicit
// import is required here — it's available to the controller via DI.
@Module({
  providers: [CarrierLookupService],
  controllers: [CarrierLookupController],
  exports: [CarrierLookupService],
})
export class LookupsModule {}
