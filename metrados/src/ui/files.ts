/** Selector de archivos del sistema, lanzado desde un clic. */
export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.hidden = true;
    let done = false;
    const finish = (files: File[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(input.files ? [...input.files] : []));
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

export const PLAN_ACCEPT = '.pdf,.dxf,.png,.jpg,.jpeg,.webp,.gif,.bmp,application/pdf,image/*';
