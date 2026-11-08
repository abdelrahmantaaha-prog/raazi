// The public halves of the keys that sign update packages, written here by
// scripts/gen-update-keys.mjs. Public on purpose: every Raazi.exe carries them
// to check a package offline. Empty means this build trusts no package at all.
static class UpdateKeys
{
    public const string Modulus1 = "mThw+IrqOaGPD90vq0Dct3fN7SGoanEKa2jAiBWGArH/iWifIPy9zwDZpHybRWHw07KEwjbOPzuLVuJjSTR5o0tKUV2AZNFwq9opc0Ub95+vUfCHkJldjaPLiJtBfBsBNg1j2ttVgm0T9VogF8WMILkGwJefSjw3St7ZmGSMw/YfmNzuWqKQhmHsWr5CTZkcG4gOCPXX2Pg/JtljQTQg5GKvcdr1zTTRIdDM8YomA7y1B/E5R4zkAI+6Z0qbzNqYWMbQXe7DeD6vGEkCiCgpLXNIezqrQpAr5PPbNaVmWm6hzbq6nWueoEVl+xK6JNWPQ8K1GnASxKYH34vsJL9bKw==";

    /** The spare, kept offline for the day the first must be retired (--second). */
    public const string Modulus2 = "";
}
