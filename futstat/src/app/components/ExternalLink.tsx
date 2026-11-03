import type { ReactNode } from 'react';
import { safeExternalUrl } from '../lib/safeUrl';

export interface ExternalLinkProps {
  href: string | undefined;
  children: ReactNode;
  className?: string;
  title?: string;
}

/**
 * Enlace a un sitio externo: solo https (safeExternalUrl), siempre en pestaña nueva con
 * rel="noopener noreferrer" (la página destino no puede controlar esta pestaña ni ver de dónde vienes).
 * Si la URL no es segura se muestra solo el texto, sin enlace.
 */
export function ExternalLink({ href, children, className, title }: ExternalLinkProps) {
  const safe = safeExternalUrl(href);
  if (!safe) return <span className={className}>{children}</span>;
  return (
    <a className={className} href={safe} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" title={title}>
      {children}
    </a>
  );
}
