import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../services/api';
import { shrinkImage } from '../lib/shrinkImage';
import AuthImage, { forgetPhoto } from './AuthImage';

export const MAX_PHOTOS = 4;
export const photoUrl = (listingId, photoId) => `/api/listings/${listingId}/photos/${photoId}`;

/** The photos of a listing (up to four), larger on a click. With `editable` the owner can also
 *  add and remove them; `onChange(photos)` hands back the new list. Nothing shows while the
 *  server has no photo storage set up. */
export default function ListingPhotos({ listing, editable = false, onChange }) {
  const { photosEnabled } = useAuth();
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const photos = listing.photos || [];
  if (!photosEnabled) return null;
  if (!photos.length && !editable) return null;

  const add = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const blob = await shrinkImage(file);
      const { photo } = await api.upload(`/api/listings/${listing.id}/photos`, blob);
      onChange([...photos, photo]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (photo) => {
    setError('');
    try {
      await api.delete(photoUrl(listing.id, photo.id));
      forgetPhoto(photoUrl(listing.id, photo.id));
      onChange(photos.filter((p) => p.id !== photo.id));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="listing-photos">
      {photos.length > 0 && (
        <div className="photo-strip">
          {photos.map((p, i) => (
            <div key={p.id} className="photo-strip__item">
              <button
                type="button"
                className="photo-strip__open"
                onClick={() => setOpen(photoUrl(listing.id, p.id))}
                aria-label={`Open photo ${i + 1} of ${photos.length}`}
              >
                <AuthImage src={photoUrl(listing.id, p.id)} className="photo-strip__img" loading="lazy" />
              </button>
              {editable && (
                <button type="button" className="photo-strip__remove" onClick={() => remove(p)} aria-label={`Remove photo ${i + 1}`}>✕</button>
              )}
            </div>
          ))}
        </div>
      )}
      {editable && photos.length < MAX_PHOTOS && (
        <label className="btn btn--secondary btn--small photo-add">
          {busy ? 'Adding…' : 'Add a photo'}
          <input type="file" accept="image/*" onChange={add} disabled={busy} hidden />
        </label>
      )}
      {error && <div className="alert alert--error" role="alert">{error}</div>}
      {open && (
        <div className="lightbox" role="dialog" aria-label="Photo" onClick={() => setOpen(null)}>
          <AuthImage src={open} className="lightbox__img" />
        </div>
      )}
    </div>
  );
}
