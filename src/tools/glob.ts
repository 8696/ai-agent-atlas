/**
 * 极简 glob 匹配 —— **只支持 `*` `**` `?`**（够用了，不引依赖）。
 *
 * 📌 **语义**：
 * - `*` —— 匹配任意字符（**不跨 `/`**）
 * - `**` —— 匹配任意字符（**跨 `/`**）
 * - `?` —— 匹配一个字符
 *
 * ⚠️ **大小写不敏感** —— 跨平台（macOS 默认大小写不敏感，Linux 敏感）。
 */

/** glob → 正则 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        // ⚠️ **`**/` 里的斜杠可以不吃** —— `a/**/b` 要能匹配 `a/b`
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

/** 这个路径符不符合 glob */
export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

/** 只要路径里含有 glob 片段（`**` `*` `?`）就算「带通配」 */
export function hasWildcard(glob: string): boolean {
  return /[*?]/.test(glob);
}
