import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { prisma } from "./db.js";

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(staff) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters");
  }
  return jwt.sign(
    { sub: staff.id, role: staff.role, mobile: staff.mobile },
    process.env.JWT_SECRET,
    { expiresIn: "8h", issuer: "radin-store-api", audience: "radin-admin" }
  );
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ message: "احراز هویت لازم است." });
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: "radin-store-api",
      audience: "radin-admin"
    });
    const staff = await prisma.staff.findUnique({ where: { id: payload.sub } });
    if (!staff || !staff.isActive) return res.status(401).json({ message: "حساب غیرفعال است." });
    req.staff = staff;
    next();
  } catch {
    return res.status(401).json({ message: "نشست نامعتبر یا منقضی است." });
  }
}

export function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.staff || !roles.includes(req.staff.role)) {
      return res.status(403).json({ message: "دسترسی کافی ندارید." });
    }
    next();
  };
}
