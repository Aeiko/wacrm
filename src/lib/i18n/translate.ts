import { createTranslator } from 'use-intl/core';
import { english } from '@/i18n/config';

export type TranslateValues = Record<string, string | number | Date>;

export type Translate = (key: string, values?: TranslateValues) => string;

// Use the library's untyped catalogue signature for dynamic namespaces and keys.
type Messages = NonNullable<Parameters<typeof createTranslator>[0]['messages']>;

/** English ICU translations for code outside React, including shared validators. */
export function getT(namespace: string): Translate {
  return createTranslator<Messages, string>({ ...english, namespace });
}
