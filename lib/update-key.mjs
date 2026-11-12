/**
 * The public half of the key that signs Goblin Horde's releases: Ed25519, as SPKI DER in base64. Every update is
 * checked against it before any of its files is written. `node scripts/release.mjs keygen` writes it here once, and a
 * build whose key is empty refuses every update.
 */
export const UPDATE_KEY = "MCowBQYDK2VwAyEAsG67n02DreAIWZcGq1G7BBqneD7EMMDsADKInk+qCaY=";
