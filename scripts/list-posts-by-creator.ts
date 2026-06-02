import "dotenv/config";
import { prisma } from "../src/config/database";

async function main() {
  const total = await prisma.post.count();
  const byCreator = await prisma.post.groupBy({
    by: ["userId"],
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
    take: 15,
  });
  const users = await prisma.user.findMany({
    where: { id: { in: byCreator.map((b) => b.userId) } },
    select: { id: true, publicId: true, username: true },
  });
  const map = new Map(users.map((u) => [u.id, u]));
  console.log("total posts:", total);
  for (const b of byCreator) {
    const u = map.get(b.userId);
    console.log(
      u?.publicId?.toString() ?? "?",
      u?.username ?? "?",
      "posts:",
      b._count.id,
    );
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
