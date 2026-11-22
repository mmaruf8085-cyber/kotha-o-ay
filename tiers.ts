import type { PackageTier, PremiumPackage, User } from '../types';

export const TIER_RANK: Record<PackageTier, number> = {
  silver: 1,
  gold: 2,
  diamond: 3,
};

export const TIER_LABELS: Record<PackageTier, string> = {
  silver: 'সিলভার প্রিমিয়াম',
  gold: 'গোল্ড প্রিমিয়াম',
  diamond: 'ডায়মন্ড ভিআইপি',
};

export function getTodayDateKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getUserMaxTierRank(user: User, packages: PremiumPackage[]): number {
  const unlockedIds = user.unlockedPackages || [];
  let maxRank = 0;
  for (const pkgId of unlockedIds) {
    const pkg = packages.find((p) => p.id === pkgId);
    if (pkg && TIER_RANK[pkg.tier] > maxRank) {
      maxRank = TIER_RANK[pkg.tier];
    }
  }
  return maxRank;
}

export function isTaskUnlockedForUser(
  requiredTier: PackageTier | undefined,
  user: User,
  packages: PremiumPackage[]
): boolean {
  if (!requiredTier) return true;
  return getUserMaxTierRank(user, packages) >= TIER_RANK[requiredTier];
}
