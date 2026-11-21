/**
 * Acceso a pdf.js desde la app: configura una sola vez el hilo de trabajo y abre documentos.
 */
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { documentOptions, workerSrc } from './worker-src';

let configured = false;

export function pdfLib(): typeof pdfjsLib {
  if (!configured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc();
    configured = true;
  }
  return pdfjsLib;
}

export class PdfPasswordError extends Error {
  constructor(readonly wrong: boolean) {
    super(wrong ? 'Contraseña incorrecta.' : 'El PDF está protegido con contraseña.');
  }
}

/** Abre un PDF desde sus bytes. pdf.js se queda con el array (lo transfiere a su hilo): pasa una copia si lo necesitas. */
export async function openPdf(data: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const lib = pdfLib();
  try {
    return await lib.getDocument({ data, password, ...documentOptions() }).promise;
  } catch (e) {
    if (e instanceof lib.PasswordException) throw new PdfPasswordError(e.code === lib.PasswordResponses.INCORRECT_PASSWORD);
    if (e instanceof lib.InvalidPDFException) throw new Error('El archivo no es un PDF válido o está dañado.');
    throw e;
  }
}

export type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
