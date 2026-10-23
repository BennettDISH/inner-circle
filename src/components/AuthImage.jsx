import React, { useEffect, useState } from 'react';

// A photo is private: the server sends it only to a signed-in circle member, and an <img> tag
// cannot send the Authorization header. So it is fetched here with the token and shown from a
// blob URL. The server marks every photo immutable, so the browser's own cache serves repeat
// visits; this map keeps one blob URL per photo for the life of the page.
const loaded = new Map(); // src -> Promise<blob URL>

function load(src) {
  if (!loaded.has(src)) {
    const token = localStorage.getItem('token');
    loaded.set(src, fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => URL.createObjectURL(blob))
      .catch((err) => {
        loaded.delete(src); // a failure is tried again next time, not remembered
        throw err;
      }));
  }
  return loaded.get(src);
}

/** Lets go of a photo's blob URL once the photo is deleted. */
export function forgetPhoto(src) {
  loaded.get(src)?.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  loaded.delete(src);
}

export default function AuthImage({ src, alt = '', className = '', ...rest }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setUrl(null);
    setFailed(false);
    load(src).then((u) => live && setUrl(u)).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [src]);

  if (failed) return <div className={`${className} photo--missing`} role="img" aria-label="This photo could not be loaded" />;
  if (!url) return <div className={`${className} photo--loading`} aria-hidden="true" />;
  return <img src={url} alt={alt} className={className} {...rest} />;
}
