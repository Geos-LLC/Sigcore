import { Injectable, Logger } from '@nestjs/common';
import { CandidateWorkspace } from './identity-resolution.service';

export interface ScoredCandidate extends CandidateWorkspace {
  score: number;
  reasons: string[];
}

export interface RoutingContext {
  channel?: string;       // 'sms' | 'voice' | 'email' | 'marketplace'
  provider?: string;      // 'openphone' | 'twilio' | 'leadbridge'
  role_hint?: string;     // 'leadbridge_assigned_number' | 'callio_main_inbox'
  purpose_hint?: string;  // 'lead_capture' | 'main_business_line'
  product_type?: string;  // filter to specific product
}

/**
 * Step 2 of two-step resolution: Score candidates and select the best workspace.
 * This service performs routing selection only — no identity resolution.
 */
@Injectable()
export class RoutingSelectionService {
  private readonly logger = new Logger(RoutingSelectionService.name);

  select(candidates: CandidateWorkspace[], context: RoutingContext): {
    selected: ScoredCandidate | null;
    alternatives: ScoredCandidate[];
  } {
    if (candidates.length === 0) {
      return { selected: null, alternatives: [] };
    }

    const scored: ScoredCandidate[] = candidates.map((candidate) => {
      let score = 0;
      const reasons: string[] = [];

      // +40: Exact provider + external_asset_id match
      if (
        context.provider &&
        candidate.asset.provider === context.provider &&
        candidate.asset.externalAssetId
      ) {
        score += 40;
        reasons.push(`provider_and_asset_id_match: ${context.provider} (+40)`);
      }
      // +30: Provider on asset matches context
      else if (context.provider && candidate.asset.provider === context.provider) {
        score += 30;
        reasons.push(`provider_match: ${context.provider} (+30)`);
      }

      // +25: Role matches hint
      if (context.role_hint && candidate.link.role === context.role_hint) {
        score += 25;
        reasons.push(`role_match: ${context.role_hint} (+25)`);
      }

      // +20: Purpose matches hint
      if (context.purpose_hint && candidate.link.purpose === context.purpose_hint) {
        score += 20;
        reasons.push(`purpose_match: ${context.purpose_hint} (+20)`);
      }

      // +15: Channel context match
      if (context.channel) {
        const channelWorkspaceAffinity: Record<string, string[]> = {
          sms: ['callio', 'leadbridge', 'serviceflow'],
          voice: ['callio', 'sigcore'],
          email: ['serviceflow', 'leadbridge'],
          marketplace: ['leadbridge'],
        };
        const preferred = channelWorkspaceAffinity[context.channel] || [];
        if (preferred.includes(candidate.workspace.productType)) {
          score += 15;
          reasons.push(`channel_affinity: ${context.channel}→${candidate.workspace.productType} (+15)`);
        }
      }

      // +10: is_primary flag
      if (candidate.link.isPrimary) {
        score += 10;
        reasons.push('is_primary (+10)');
      }

      // +5: Workspace active
      score += 5;
      reasons.push('workspace_active (+5)');

      // Filter: product_type match (mandatory filter, not scoring)
      if (context.product_type && candidate.workspace.productType !== context.product_type) {
        score = -1; // Exclude from selection
        reasons.push(`product_type_mismatch: wanted ${context.product_type}, got ${candidate.workspace.productType} (excluded)`);
      }

      return { ...candidate, score, reasons };
    });

    // Remove excluded candidates
    const eligible = scored.filter((c) => c.score >= 0);
    eligible.sort((a, b) => b.score - a.score);

    const selected = eligible.length > 0 ? eligible[0] : null;
    const alternatives = eligible.slice(1);

    if (selected) {
      this.logger.log(
        `Routing selected: ${selected.workspace.productType}/${selected.workspace.externalWorkspaceId} (score=${selected.score})`,
      );
    } else {
      this.logger.warn(`No eligible routing candidate found for context: ${JSON.stringify(context)}`);
    }

    return { selected, alternatives };
  }
}
