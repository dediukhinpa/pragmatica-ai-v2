// Сгенерировано из shared/currencies.json (scripts/sync-shared.sh), не править.

export interface CurrencyEntry {
  code: string;
  /** Символы валюты («₽», «$»). */
  symbols: readonly string[];
  /** Слова и сокращения в нижнем регистре («руб.», «евро»). */
  aliases: readonly string[];
}

export const PRICE_CURRENCIES: readonly CurrencyEntry[] = [
  {
    code: 'RUB',
    symbols: ['₽'],
    aliases: ['руб', 'руб.', 'р.', 'rub', 'рубль', 'рубля', 'рубли', 'рублей', 'р', 'rur'],
  },
  {
    code: 'USD',
    symbols: ['$'],
    aliases: ['usd', 'долл', 'доллар', 'доллара', 'доллары', 'долларов', 'долл.'],
  },
  {
    code: 'EUR',
    symbols: ['€'],
    aliases: ['eur', 'евро'],
  },
  {
    code: 'CNY',
    symbols: ['¥'],
    aliases: ['cny', 'юань', 'юаня', 'юани', 'юаней', 'rmb'],
  },
  {
    code: 'KZT',
    symbols: ['₸'],
    aliases: ['kzt', 'тенге', 'тг', 'тг.'],
  },
  {
    code: 'BYN',
    symbols: [],
    aliases: ['byn'],
  },
];
