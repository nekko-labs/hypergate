export type View = 'servers' | 'analytics' | 'settings';
export type Theme = 'light' | 'medium' | 'dark';

export interface JsonSchema {
  type?: string;
  properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
  required?: string[];
}
