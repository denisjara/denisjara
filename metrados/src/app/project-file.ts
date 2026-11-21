/**
 * Archivo de proyecto (.zip): el proyecto en JSON y los planos originales, para hacer copias de seguridad o
 * pasar el trabajo a otro equipo. Los planos se guardan tal cual, sin recomprimir.
 */
import { newId, sanitizeProject, type Project } from '../core/model';
import { readZip, zipBlob, type ZipInput } from '../io/zip';
import { fileBlob } from './plans';

const MANIFEST = 'proyecto.json';
const safeName = (name: string): string => name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'plano';

export async function exportProjectFile(project: Project): Promise<{ blob: Blob; missing: string[] }> {
  const entries: ZipInput[] = [{ name: MANIFEST, data: new TextEncoder().encode(JSON.stringify(project)) }];
  const missing: string[] = [];
  for (const f of project.files) {
    const blob = fileBlob(f.id);
    if (blob) entries.push({ name: `planos/${f.id}/${safeName(f.name)}`, data: blob });
    else missing.push(f.name);
  }
  return { blob: await zipBlob(entries, 'application/zip'), missing };
}

export interface ImportedProject {
  project: Project;
  blobs: Map<string, Blob>;
  /** Planos que el archivo menciona pero no contiene. */
  missing: string[];
}

export async function importProjectFile(file: Blob): Promise<ImportedProject> {
  let entries;
  try {
    entries = await readZip(file);
  } catch {
    throw new Error('El archivo no es un proyecto de Metrado Lab (.zip) o está dañado.');
  }
  const manifest = entries.find((e) => e.name === MANIFEST);
  if (!manifest) throw new Error('El archivo no contiene un proyecto de Metrado Lab.');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await manifest.read()));
  } catch {
    throw new Error('El proyecto del archivo está dañado.');
  }
  const parsed = sanitizeProject(raw);
  if (!parsed) throw new Error('El proyecto del archivo no tiene un formato reconocido.');
  // Identificadores nuevos: importar dos veces el mismo archivo no debe pisar el proyecto ya guardado.
  const idMap = new Map(parsed.files.map((f) => [f.id, newId('file')]));
  const blobs = new Map<string, Blob>();
  const missing: string[] = [];
  for (const f of parsed.files) {
    const entry = entries.find((e) => e.name.startsWith(`planos/${f.id}/`));
    if (!entry) {
      missing.push(f.name);
      continue;
    }
    const type = f.kind === 'pdf' ? 'application/pdf' : f.kind === 'dxf' ? 'application/dxf' : '';
    blobs.set(idMap.get(f.id)!, new Blob([(await entry.read()) as BlobPart], { type }));
  }
  const project: Project = {
    ...parsed,
    id: newId('proj'),
    files: parsed.files.map((f) => ({ ...f, id: idMap.get(f.id)! })),
    sheets: parsed.sheets.map((s) => ({ ...s, fileId: idMap.get(s.fileId) ?? s.fileId })),
  };
  delete project.sample;
  return { project, blobs, missing };
}
