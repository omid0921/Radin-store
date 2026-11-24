import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { z } from "zod";
import { prisma } from "./db.js";
import { hashPassword, verifyPassword, signToken, requireAuth, allowRoles } from "./auth.js";

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") || false }));
app.use(express.json({ limit: "1mb" }));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Process-local protection for development/single-instance deployments.
// Use a shared store (for example Redis) before running multiple API instances.
function rateLimit({ windowMs, max, message }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    if (buckets.size > 10000) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
    }
    let entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }
    entry.count += 1;
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > max) return res.status(429).json({ message });
    next();
  };
}
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: "تعداد تلاش ورود بیش از حد مجاز است. کمی بعد دوباره تلاش کنید." });
const bootstrapLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: "تعداد درخواست راه‌اندازی بیش از حد مجاز است." });
const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 8, message: "تعداد ثبت سفارش زیاد است؛ کمی بعد دوباره تلاش کنید." });
const money = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const variantSchema = z.object({
  title: z.string().trim().min(1).max(120),
  sku: z.string().trim().max(80).optional().nullable(),
  barcode: z.string().trim().max(80).optional().nullable(),
  retailPrice: money,
  wholesalePrice: money.default(0),
  purchasePrice: money.default(0),
  stockQuantity: z.coerce.number().int().nonnegative().default(0),
  minimumStock: z.coerce.number().int().nonnegative().default(3)
});
const productSchema = z.object({
  name: z.string().trim().min(1).max(180),
  brand: z.string().trim().max(120).optional().nullable(),
  description: z.string().max(4000).optional().nullable(),
  categoryId: z.string().optional().nullable(),
  variants: z.array(variantSchema).min(1).max(100)
});
const orderSchema = z.object({
  customerName: z.string().trim().min(2).max(120),
  mobile: z.string().trim().regex(/^[0-9+\- ]{8,20}$/),
  city: z.string().trim().min(2).max(100),
  address: z.string().trim().min(8).max(1000),
  postalCode: z.string().trim().max(20).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  items: z.array(z.object({ variantId: z.string().min(1), quantity: z.coerce.number().int().min(1).max(50) })).min(1).max(50)
}).strict();

app.get("/health", (_req, res) => res.json({ ok: true, service: "radin-store-api", version: "0.8.0" }));

app.post("/auth/bootstrap-owner", bootstrapLimiter, asyncRoute(async (req, res) => {
  const body = z.object({
    secret: z.string().min(16),
    mobile: z.string().trim().min(8).max(20),
    fullName: z.string().trim().min(2).max(120),
    password: z.string().min(10).max(100)
  }).parse(req.body);

  if (!process.env.OWNER_BOOTSTRAP_SECRET ||
      body.secret !== process.env.OWNER_BOOTSTRAP_SECRET) {
    return res.status(403).json({ message: "کلید راه‌اندازی معتبر نیست." });
  }
  const passwordHash = await hashPassword(body.password);
  const staff = await prisma.$transaction(async (tx) => {
    // Serialize first-owner creation across concurrent requests on PostgreSQL.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(74192831)`;
    const count = await tx.staff.count({ where: { role: "OWNER" } });
    if (count > 0) throw Object.assign(new Error("مدیر اصلی قبلاً ساخته شده است."), { status: 409 });
    return tx.staff.create({
      data: { mobile: body.mobile, fullName: body.fullName, passwordHash, role: "OWNER" },
      select: { id: true, mobile: true, fullName: true, role: true }
    });
  });
  return res.status(201).json({ staff });
}));

app.post("/auth/login", loginLimiter, asyncRoute(async (req, res) => {
  const body = z.object({
    mobile: z.string().trim().min(8).max(20),
    password: z.string().min(1).max(100)
  }).parse(req.body);
  const staff = await prisma.staff.findUnique({ where: { mobile: body.mobile } });
  if (!staff || !staff.isActive || !(await verifyPassword(body.password, staff.passwordHash))) {
    return res.status(401).json({ message: "شماره موبایل یا رمز عبور اشتباه است." });
  }
  res.json({
    token: signToken(staff),
    expiresIn: 28800,
    staff: { id: staff.id, mobile: staff.mobile, fullName: staff.fullName, role: staff.role }
  });
}));

app.get("/auth/me", requireAuth, (req, res) => {
  const { id, mobile, fullName, role } = req.staff;
  res.json({ id, mobile, fullName, role });
});

// Public catalogue intentionally never returns wholesale or purchase prices.
app.get("/public/products", asyncRoute(async (req, res) => {
  const products = await prisma.product.findMany({
    where: { isActive: true, variants: { some: { isActive: true } } },
    include: {
      category: { select: { id: true, name: true } },
      variants: {
        where: { isActive: true },
        select: { id: true, title: true, sku: true, retailPrice: true, stockQuantity: true }
      }
    },
    orderBy: { createdAt: "desc" }
  });
  res.json(products.map(p => ({
    id: p.id, name: p.name, brand: p.brand, description: p.description,
    category: p.category,
    variants: p.variants.map(v => ({ ...v, retailPrice: v.retailPrice.toString() }))
  })));
}));

app.get("/admin/products", requireAuth, allowRoles("OWNER", "WAREHOUSE"), asyncRoute(async (_req, res) => {
  const products = await prisma.product.findMany({
    include: { category: true, variants: { orderBy: { createdAt: "asc" } } },
    orderBy: { updatedAt: "desc" }
  });
  res.json(products.map(p => ({
    ...p,
    variants: p.variants.map(v => ({
      ...v,
      retailPrice: v.retailPrice.toString(),
      wholesalePrice: v.wholesalePrice.toString(),
      purchasePrice: v.purchasePrice.toString()
    }))
  })));
}));

app.post("/admin/products", requireAuth, allowRoles("OWNER", "WAREHOUSE"), asyncRoute(async (req, res) => {
  const body = productSchema.parse(req.body);
  const product = await prisma.product.create({
    data: {
      name: body.name, brand: body.brand, description: body.description,
      categoryId: body.categoryId || null,
      variants: { create: body.variants.map(v => ({
        ...v, sku: v.sku || null, barcode: v.barcode || null,
        retailPrice: BigInt(v.retailPrice),
        wholesalePrice: BigInt(v.wholesalePrice),
        purchasePrice: BigInt(v.purchasePrice)
      })) }
    },
    include: { variants: true, category: true }
  });
  res.status(201).json({ id: product.id, name: product.name, variantsCount: product.variants.length });
}));

app.patch("/admin/products/:id", requireAuth, allowRoles("OWNER", "WAREHOUSE"), asyncRoute(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(1).max(180).optional(),
    brand: z.string().trim().max(120).nullable().optional(),
    description: z.string().max(4000).nullable().optional(),
    categoryId: z.string().nullable().optional(),
    isActive: z.boolean().optional()
  }).strict().parse(req.body);
  const updated = await prisma.product.update({ where: { id: req.params.id }, data: body });
  res.json({ id: updated.id, name: updated.name, isActive: updated.isActive });
}));

app.post("/admin/products/:productId/variants", requireAuth, allowRoles("OWNER", "WAREHOUSE"), asyncRoute(async (req, res) => {
  const body = variantSchema.parse(req.body);
  const variant = await prisma.productVariant.create({
    data: {
      productId: req.params.productId, ...body,
      sku: body.sku || null, barcode: body.barcode || null,
      retailPrice: BigInt(body.retailPrice),
      wholesalePrice: BigInt(body.wholesalePrice),
      purchasePrice: BigInt(body.purchasePrice)
    }
  });
  res.status(201).json({ id: variant.id, title: variant.title });
}));

app.patch("/admin/variants/:id", requireAuth, allowRoles("OWNER", "WAREHOUSE"), asyncRoute(async (req, res) => {
  const body = variantSchema.partial().extend({ isActive: z.boolean().optional() }).strict().parse(req.body);
  const data = { ...body };
  for (const key of ["retailPrice", "wholesalePrice", "purchasePrice"]) {
    if (data[key] !== undefined) data[key] = BigInt(data[key]);
  }
  const variant = await prisma.productVariant.update({ where: { id: req.params.id }, data });
  res.json({ id: variant.id, title: variant.title, isActive: variant.isActive });
}));

app.post("/admin/variants/:id/stock-movements", requireAuth, allowRoles("OWNER", "WAREHOUSE"), asyncRoute(async (req, res) => {
  const body = z.object({
    type: z.enum(["IN", "OUT", "ADJUSTMENT"]),
    quantity: z.coerce.number().int().positive(),
    reason: z.string().trim().min(3).max(300)
  }).parse(req.body);

  const result = await prisma.$transaction(async tx => {
    const variant = await tx.productVariant.findUnique({ where: { id: req.params.id }, select: { id: true, stockQuantity: true } });
    if (!variant) throw Object.assign(new Error("تنوع کالا پیدا نشد."), { status: 404 });

    let updated;
    if (body.type === "IN") {
      updated = await tx.productVariant.update({ where: { id: variant.id }, data: { stockQuantity: { increment: body.quantity } }, select: { stockQuantity: true } });
    } else if (body.type === "OUT") {
      // Conditional decrement prevents two simultaneous sales from overselling stock.
      const changed = await tx.productVariant.updateMany({
        where: { id: variant.id, stockQuantity: { gte: body.quantity } },
        data: { stockQuantity: { decrement: body.quantity } }
      });
      if (changed.count !== 1) throw Object.assign(new Error("موجودی کافی نیست."), { status: 409 });
      updated = await tx.productVariant.findUnique({ where: { id: variant.id }, select: { stockQuantity: true } });
    } else {
      // ADJUSTMENT.quantity means the absolute target stock, not a delta.
      updated = await tx.productVariant.update({ where: { id: variant.id }, data: { stockQuantity: body.quantity }, select: { stockQuantity: true } });
    }
    const movement = await tx.stockMovement.create({
      data: { variantId: variant.id, type: body.type, quantity: body.quantity, reason: body.reason }
    });
    return { previousStockQuantity: variant.stockQuantity, stockQuantity: updated.stockQuantity, movementId: movement.id };
  });
  res.status(201).json(result);
}));

app.post("/admin/categories", requireAuth, allowRoles("OWNER", "WAREHOUSE"), asyncRoute(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(100) }).parse(req.body);
  const category = await prisma.category.create({ data: { name: body.name } });
  res.status(201).json(category);
}));

app.get("/public/categories", asyncRoute(async (_req, res) => {
  const categories = await prisma.category.findMany({
    where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" }
  });
  res.json(categories);
}));

// Customer checkout: prices are always read from the database, never trusted from the browser.
// Orders are created unpaid and pending store review; no payment is claimed or collected here.
app.post("/public/orders", orderLimiter, asyncRoute(async (req, res) => {
  const body = orderSchema.parse(req.body);
  const quantities = new Map();
  for (const item of body.items) quantities.set(item.variantId, (quantities.get(item.variantId) || 0) + item.quantity);
  if ([...quantities.values()].some(q => q > 50)) return res.status(400).json({ message: "تعداد یک تنوع کالا بیش از حد مجاز است." });

  const order = await prisma.$transaction(async tx => {
    const ids = [...quantities.keys()].sort();
    const variants = await tx.productVariant.findMany({
      where: { id: { in: ids }, isActive: true, product: { isActive: true } },
      include: { product: { select: { name: true } } }
    });
    if (variants.length !== ids.length) throw Object.assign(new Error("یکی از کالاهای انتخاب‌شده دیگر فعال نیست."), { status: 409 });
    const byId = new Map(variants.map(v => [v.id, v]));
    let total = 0n;
    const lines = [];
    for (const [variantId, quantity] of quantities) {
      const v = byId.get(variantId);
      if (v.stockQuantity < quantity) throw Object.assign(new Error(`موجودی «${v.product.name} - ${v.title}» کافی نیست.`), { status: 409 });
      const lineTotal = v.retailPrice * BigInt(quantity);
      total += lineTotal;
      lines.push({ variantId, productTitle: v.product.name, variantTitle: v.title, unitPrice: v.retailPrice, quantity, lineTotal });
    }
    const customer = await tx.customer.upsert({
      where: { mobile: body.mobile },
      create: { mobile: body.mobile, fullName: body.customerName },
      update: { fullName: body.customerName }
    });
    const orderNumber = `RD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const created = await tx.order.create({
      data: {
        orderNumber, customerId: customer.id, customerName: body.customerName,
        mobile: body.mobile, city: body.city, address: body.address,
        postalCode: body.postalCode || null, notes: body.notes || null,
        totalAmount: total, items: { create: lines }
      },
      include: { items: true }
    });
    for (const line of lines) {
      const changed = await tx.productVariant.updateMany({
        where: { id: line.variantId, isActive: true, stockQuantity: { gte: line.quantity } },
        data: { stockQuantity: { decrement: line.quantity } }
      });
      if (changed.count !== 1) throw Object.assign(new Error("موجودی یکی از کالاها هم‌زمان تغییر کرد؛ سفارش ثبت نشد. سبد را تازه‌سازی کنید."), { status: 409 });
      await tx.stockMovement.create({ data: { variantId: line.variantId, type: "OUT", quantity: line.quantity, reason: `رزرو سفارش ${orderNumber}` } });
    }
    return created;
  }, { isolationLevel: "Serializable" });

  res.status(201).json({
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    totalAmount: order.totalAmount.toString(),
    message: "درخواست سفارش ثبت شد. فروشگاه برای تأیید نهایی با شما تماس می‌گیرد."
  });
}));

app.get("/admin/orders", requireAuth, allowRoles("OWNER", "SELLER", "ORDER_MANAGER"), asyncRoute(async (req, res) => {
  const orders = await prisma.order.findMany({
    include: { items: true }, orderBy: { createdAt: "desc" }, take: 100
  });
  res.json(orders.map(o => ({ ...o, totalAmount: o.totalAmount.toString(), items: o.items.map(i => ({ ...i, unitPrice: i.unitPrice.toString(), lineTotal: i.lineTotal.toString() })) })));
}));

app.patch("/admin/orders/:id/status", requireAuth, allowRoles("OWNER", "ORDER_MANAGER"), asyncRoute(async (req, res) => {
  const body = z.object({ status: z.enum(["CONFIRMED", "PREPARING", "SHIPPED", "DELIVERED", "CANCELLED"]) }).parse(req.body);
  const result = await prisma.$transaction(async tx => {
    const order = await tx.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!order) throw Object.assign(new Error("سفارش پیدا نشد."), { status: 404 });
    if (["CANCELLED", "DELIVERED"].includes(order.status)) throw Object.assign(new Error("وضعیت این سفارش دیگر قابل تغییر نیست."), { status: 409 });
    if (body.status === "CANCELLED" && order.status === "SHIPPED") throw Object.assign(new Error("سفارش ارسال‌شده را نمی‌توان از این مسیر لغو کرد."), { status: 409 });
    const allowed = {
      PENDING_REVIEW: ["CONFIRMED", "CANCELLED"],
      CONFIRMED: ["PREPARING", "CANCELLED"],
      PREPARING: ["SHIPPED", "CANCELLED"],
      SHIPPED: ["DELIVERED"],
      DELIVERED: [], CANCELLED: []
    };
    if (!allowed[order.status]?.includes(body.status)) throw Object.assign(new Error("تغییر وضعیت انتخاب‌شده مجاز نیست."), { status: 409 });
    if (body.status === "CANCELLED") {
      for (const item of order.items) {
        await tx.productVariant.update({ where: { id: item.variantId }, data: { stockQuantity: { increment: item.quantity } } });
        await tx.stockMovement.create({ data: { variantId: item.variantId, type: "IN", quantity: item.quantity, reason: `بازگشت موجودی سفارش لغوشده ${order.orderNumber}` } });
      }
    }
    return tx.order.update({ where: { id: order.id }, data: { status: body.status } });
  }, { isolationLevel: "Serializable" });
  res.json({ id: result.id, orderNumber: result.orderNumber, status: result.status });
}));

app.use((err, _req, res, _next) => {
  if (err instanceof z.ZodError) return res.status(400).json({ message: "اطلاعات ورودی معتبر نیست.", issues: err.issues });
  if (err.code === "P2002") return res.status(409).json({ message: "مقدار یکتای واردشده قبلاً ثبت شده است." });
  if (err.code === "P2025") return res.status(404).json({ message: "مورد درخواستی پیدا نشد." });
  if (err.code === "P2034") return res.status(409).json({ message: "اطلاعات هم‌زمان تغییر کرد؛ درخواست را دوباره بررسی و ارسال کنید." });
  console.error(err);
  res.status(err.status || 500).json({ message: err.status ? err.message : "خطای داخلی سرور." });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`Radin API listening on http://localhost:${port}`));
