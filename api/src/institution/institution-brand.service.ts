import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connector, PluggyClient } from 'pluggy-sdk';

export const MEU_PLUGGY_CONNECTOR_ID = 200;

/** Common Brazilian COMPE codes → names used to match Pluggy connectors */
export const COMPE_BANK_HINTS: Record<string, string[]> = {
  '001': ['Banco do Brasil', 'BB'],
  '033': ['Santander'],
  '104': ['Caixa', 'CEF'],
  '237': ['Bradesco'],
  '341': ['Itaú', 'Itau'],
  '260': ['Nubank', 'Nu Pagamentos'],
  '077': ['Inter'],
  '336': ['C6'],
  '380': ['PicPay'],
  '323': ['Mercado Pago', 'MercadoPago'],
  '348': ['XP'],
  '102': ['XP'],
  '756': ['Sicoob'],
  '212': ['Original'],
  '637': ['Sofisa'],
  '208': ['BTG', 'BTG Pactual'],
  '121': ['Agibank'],
  '290': ['PagBank', 'PagSeguro'],
  '197': ['Stone'],
  '403': ['Cora'],
  '623': ['Banco Pan', 'Pan'],
};

export type InstitutionBrand = {
  name: string | null;
  imageUrl: string | null;
  primaryColor: string | null;
  compeCode: string | null;
};

export type InstitutionOption = {
  id: number;
  name: string;
  imageUrl: string;
  primaryColor: string | null;
  type: string;
  isOpenFinance: boolean;
};

const DEFAULT_INSTITUTION_SEARCHES = [
  'Nubank',
  'Itaú',
  'Bradesco',
  'Santander',
  'XP',
  'Sicoob',
  'Inter',
  'C6',
  'PicPay',
  'Mercado Pago',
  'Wise',
  'Banco do Brasil',
  'Caixa',
  'BTG',
  'PagBank',
  'Original',
  'Neon',
  'Will',
];

@Injectable()
export class InstitutionBrandService {
  private readonly logger = new Logger(InstitutionBrandService.name);
  private readonly client: PluggyClient;
  private connectorsCache: Connector[] | null = null;
  private connectorsCacheAt = 0;

  constructor(private readonly config: ConfigService) {
    this.client = new PluggyClient({
      clientId: this.config.getOrThrow<string>('PLUGGY_CLIENT_ID'),
      clientSecret: this.config.getOrThrow<string>('PLUGGY_CLIENT_SECRET'),
    });
  }

  async resolveFromHints(params: {
    nameHints: string[];
    compeCodes?: string[];
  }): Promise<InstitutionBrand> {
    const nameHints = params.nameHints.filter(Boolean);
    const compeCodes = params.compeCodes ?? [];
    const searchTerms = this.buildSearchTerms(nameHints, compeCodes);
    const candidates = await this.searchConnectors(searchTerms);

    let best: { connector: Connector; score: number } | null = null;

    for (const connector of candidates) {
      if (connector.id === MEU_PLUGGY_CONNECTOR_ID) {
        continue;
      }
      const score = this.scoreConnectorMatch(connector, nameHints, compeCodes);
      if (score <= 0) {
        continue;
      }
      if (!best || score > best.score) {
        best = { connector, score };
      }
    }

    if (best) {
      return {
        name: best.connector.name,
        imageUrl: best.connector.imageUrl,
        primaryColor: this.normalizeColor(best.connector.primaryColor),
        compeCode: compeCodes[0] ?? null,
      };
    }

    const fallbackName =
      nameHints[0] ??
      (compeCodes[0] ? (COMPE_BANK_HINTS[compeCodes[0]]?.[0] ?? null) : null);

    return {
      name: fallbackName,
      imageUrl: null,
      primaryColor: null,
      compeCode: compeCodes[0] ?? null,
    };
  }

  async resolveFromAccountName(accountName: string): Promise<InstitutionBrand> {
    const hint = this.cleanAccountBankName(accountName);
    return this.resolveFromHints({
      nameHints: hint ? [hint, accountName] : [accountName],
    });
  }

  async listInstitutions(search?: string): Promise<InstitutionOption[]> {
    const terms = search?.trim()
      ? [search.trim()]
      : DEFAULT_INSTITUTION_SEARCHES;

    const byId = new Map<number, InstitutionOption>();

    for (const term of terms) {
      try {
        const page = await this.client.fetchConnectors({
          countries: ['BR'],
          name: term,
        });
        for (const connector of page.results) {
          if (connector.id === MEU_PLUGGY_CONNECTOR_ID) {
            continue;
          }
          if (!connector.imageUrl) {
            continue;
          }
          byId.set(connector.id, {
            id: connector.id,
            name: connector.name,
            imageUrl: connector.imageUrl,
            primaryColor: this.normalizeColor(connector.primaryColor),
            type: connector.type,
            isOpenFinance: Boolean(connector.isOpenFinance),
          });
        }
      } catch (error) {
        this.logger.debug(
          `Institution list search failed for "${term}": ${String(error)}`,
        );
      }
    }

    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  extractCompeCodesFromTransferNumbers(
    transferNumbers: Array<string | null | undefined>,
  ): string[] {
    const codes = new Set<string>();
    for (const transferNumber of transferNumbers) {
      if (!transferNumber) {
        continue;
      }
      const match = /^(\d{3})\//.exec(transferNumber);
      if (match) {
        codes.add(match[1]);
      }
    }
    return [...codes];
  }

  extractBankNameHints(accountNames: string[]): string[] {
    const counts = new Map<string, number>();

    for (const accountName of accountNames) {
      const cleaned = this.cleanAccountBankName(accountName);
      if (!cleaned) {
        continue;
      }
      counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
  }

  cleanAccountBankName(name: string): string | null {
    let value = name.trim();
    if (!value) {
      return null;
    }

    // Skip generic wallet / cash labels
    if (/^(carteira|dinheiro|cash|wallet)$/i.test(value)) {
      return null;
    }

    value = value
      .replace(/^cart[aã]o\s+/i, '')
      .replace(/\bvisa\b/gi, '')
      .replace(/\bmastercard\b/gi, '')
      .replace(/\binfinite\b/gi, '')
      .replace(/\bblack\b/gi, '')
      .replace(/\bplatinum\b/gi, '')
      .replace(/\bgold\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    const parts = value.split(' ').filter(Boolean);
    if (parts.length === 0) {
      return null;
    }

    if (parts[0].length <= 3 && parts.length > 1) {
      return `${parts[0]} ${parts[1]}`.trim();
    }

    return parts[0];
  }

  normalizeColor(color: string | null | undefined): string | null {
    if (!color) {
      return null;
    }
    return `#${color.replace(/^#/, '')}`;
  }

  private buildSearchTerms(
    nameHints: string[],
    compeCodes: string[],
  ): string[] {
    const terms = new Set<string>();
    for (const hint of nameHints) {
      terms.add(hint);
    }
    for (const compe of compeCodes) {
      for (const alias of COMPE_BANK_HINTS[compe] ?? []) {
        terms.add(alias);
      }
    }
    return [...terms];
  }

  private async searchConnectors(terms: string[]): Promise<Connector[]> {
    const byId = new Map<number, Connector>();

    for (const term of terms) {
      try {
        const page = await this.client.fetchConnectors({
          countries: ['BR'],
          name: term,
        });
        for (const connector of page.results) {
          byId.set(connector.id, connector);
        }
      } catch (error) {
        this.logger.debug(
          `Connector search failed for "${term}": ${String(error)}`,
        );
      }
    }

    if (byId.size === 0) {
      const all = await this.getConnectors();
      for (const connector of all) {
        byId.set(connector.id, connector);
      }
    }

    return [...byId.values()];
  }

  private async getConnectors(): Promise<Connector[]> {
    const now = Date.now();
    if (
      this.connectorsCache &&
      now - this.connectorsCacheAt < 6 * 60 * 60 * 1000
    ) {
      return this.connectorsCache;
    }

    const page = await this.client.fetchConnectors({ countries: ['BR'] });
    this.connectorsCache = page.results;
    this.connectorsCacheAt = now;
    return this.connectorsCache;
  }

  private scoreConnectorMatch(
    connector: Connector,
    nameHints: string[],
    compeCodes: string[],
  ): number {
    const connectorName = this.normalizeText(connector.name);
    let score = 0;

    for (const hint of nameHints) {
      const normalizedHint = this.normalizeText(hint);
      if (!normalizedHint) {
        continue;
      }
      if (connectorName === normalizedHint) {
        score += 100;
      } else if (
        connectorName.includes(normalizedHint) ||
        normalizedHint.includes(connectorName)
      ) {
        score += 60;
      }
    }

    for (const compe of compeCodes) {
      const aliases = COMPE_BANK_HINTS[compe] ?? [];
      for (const alias of aliases) {
        const normalizedAlias = this.normalizeText(alias);
        if (
          connectorName === normalizedAlias ||
          connectorName.includes(normalizedAlias) ||
          normalizedAlias.includes(connectorName)
        ) {
          score += 40;
        }
      }
    }

    if (connector.isOpenFinance) {
      score += 2;
    }

    return score;
  }

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
}
