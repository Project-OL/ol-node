/**
 * A gift is "lucky" when its flag is set OR its category is named/slugged "lucky"
 * (case-insensitive). Mirrors Live-server's `isLuckyGift()` (serviceLive.js), which owns
 * the lucky draw: keep the two in step, or the catalogs and send guards disagree.
 */
export function isLuckyGift(gift: {
  isLucky: boolean
  category?: { name: string; slug: string } | null
}): boolean {
  if (gift.isLucky) return true
  const cat = gift.category
  return cat?.name?.toLowerCase() === 'lucky' || cat?.slug?.toLowerCase() === 'lucky'
}
