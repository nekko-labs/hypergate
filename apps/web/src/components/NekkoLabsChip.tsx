import type { RegistryEntry } from '@hypergate/shared';

/** The "Nekko Labs" tag on a catalog or search row for a product Nekko Labs makes. */
export function NekkoLabsChip({ e }: { e: Pick<RegistryEntry, 'nekkoLabs'> }) {
  if (!e.nekkoLabs) return null;
  return <span className="chip chip-nekko" title="Made by Nekko Labs, the makers of Hypergate">Nekko Labs</span>;
}
