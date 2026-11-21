/**
 * Acceso a pdf.js desde la app: prepara una sola vez su hilo de trabajo y abre documentos.
 */
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { documentOptions, prepareWorker } from './worker-src';

export const pdfLib = (): typeof pdfjsLib => pdfjsLib;

let ready: Promise<void> | null = null;

export class PdfPasswordError extends Error {
  constructor(readonly wrong: boolean) {
    super(wrong ? 'Contraseña incorrecta.' : 'El PDF está protegido con contraseña.');
  }
}

/** Abre un PDF desde sus bytes. pdf.js se queda con el array (lo transfiere a su hilo): pasa una copia si lo necesitas. */
export async function openPdf(data: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  ready ??= prepareWorker(pdfjsLib);
  await ready;
  try {
    return await pdfjsLib.getDocument({ data, password, ...documentOptions() }).promise;
  } catch (e) {
    if (e instanceof pdfjsLib.PasswordException) throw new PdfPasswordError(e.code === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
    if (e instanceof pdfjsLib.InvalidPDFException) throw new Error('El archivo no es un PDF válido o está dañado.');
    throw e;
  }
}

export type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
