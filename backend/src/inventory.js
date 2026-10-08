import { z } from "zod";
import { id } from "./database.js";
export const deviceTypes = ["TABLET", "NOTEBOOK", "CHROMEBOOK", "CELULAR"];
const optionalText = z.string().trim().max(200).default("");
export const deviceFields = {
  internal_id: optionalText,
  serial_number: optionalText,
  manufacturer: optionalText,
  model: optionalText,
};
export const importSchema = z.object({
  dry_run: z.boolean().default(true),
  records: z
    .array(
      z.object({
        number: z.string().trim().min(1).max(200),
        qr: z.string().trim().min(1).max(200),
        ...deviceFields,
        type: z.enum(deviceTypes),
        status: z.enum(["BOM_ESTADO", "CONSERVADO"]),
        notes: z.string().trim().max(2000).default(""),
      }),
    )
    .min(1)
    .max(1000),
});
export async function planInventoryImport(db, records) {
  const existing = await db.prepare("SELECT * FROM devices").all();
  const identifiers = new Map();
  for (const device of existing)
    for (const value of [
      device.number,
      device.internal_id,
      device.qr,
      device.serial_number,
    ].filter(Boolean)) {
      const matches = identifiers.get(value) || new Set();
      matches.add(device);
      identifiers.set(value, matches);
    }
  const seen = new Set();
  const plan = { create: [], update: [], unchanged: 0, conflicts: [] };
  for (const row of records) {
    const codes = [
      ...new Set(
        [row.number, row.internal_id, row.qr, row.serial_number].filter(
          Boolean,
        ),
      ),
    ];
    if (codes.some((code) => seen.has(code))) {
      plan.conflicts.push(`${row.number}: identificador repetido na planilha.`);
      continue;
    }
    codes.forEach((code) => seen.add(code));
    const matches = new Set(
      codes.flatMap((code) => [...(identifiers.get(code) || [])]),
    );
    if (matches.size > 1) {
      plan.conflicts.push(
        `${row.number}: identificadores correspondem a aparelhos diferentes.`,
      );
      continue;
    }
    const device = [...matches][0];
    if (!device) {
      plan.create.push(row);
      continue;
    }
    if (
      !device.active ||
      device.type !== row.type ||
      (device.internal_id &&
        row.internal_id &&
        device.internal_id !== row.internal_id) ||
      (device.serial_number &&
        row.serial_number &&
        device.serial_number !== row.serial_number)
    ) {
      plan.conflicts.push(
        `${row.number}: cadastro existente incompatível ou desativado.`,
      );
      continue;
    }
    // Never overwrite QR, state, internal number, notes or existing metadata.
    const enriched = { ...device };
    for (const field of [
      "internal_id",
      "serial_number",
      "manufacturer",
      "model",
    ])
      if (!enriched[field]) enriched[field] = row[field];
    if (
      ["internal_id", "serial_number", "manufacturer", "model"].some(
        (field) => enriched[field] !== device[field],
      )
    )
      plan.update.push(enriched);
    else plan.unchanged++;
  }
  return plan;
}
export async function applyInventoryImport(db, plan) {
  for (const row of plan.create)
    await db
      .prepare(
        "INSERT INTO devices(id,number,qr,type,status,notes,internal_id,serial_number,manufacturer,model) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id(),
        row.number,
        row.qr,
        row.type,
        row.status,
        row.notes,
        row.internal_id,
        row.serial_number,
        row.manufacturer,
        row.model,
      );
  for (const row of plan.update)
    await db
      .prepare(
        "UPDATE devices SET internal_id=?,serial_number=?,manufacturer=?,model=? WHERE id=?",
      )
      .run(
        row.internal_id,
        row.serial_number,
        row.manufacturer,
        row.model,
        row.id,
      );
}
