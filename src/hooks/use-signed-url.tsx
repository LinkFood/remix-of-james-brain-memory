import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Hook to get a signed URL for a private storage file.
 * Since the 'dumps' bucket is now private, we need signed URLs to display images.
 * 
 * Supports two formats:
 * 1. Storage path: "dumps/userId/filename.png" (new format - bucket/path)
 * 2. Full URL: "https://<project>.supabase.co/storage/v1/object/public/dumps/..." (legacy)
 */
export function useSignedUrl(imageUrl: string | null | undefined) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!imageUrl) {
      setSignedUrl(null);
      return;
    }

    // Parse the image URL to extract bucket and path
    const parsed = parseStorageUrl(imageUrl);
    
    if (!parsed) {
      // Not a Supabase storage reference, use as-is (could be external URL or data URL)
      setSignedUrl(imageUrl);
      return;
    }

    const { bucket, filePath } = parsed;

    setLoading(true);
    setError(null);

    supabase.storage
      .from(bucket)
      .createSignedUrl(filePath, 3600) // 1 hour expiry
      .then(({ data, error: signError }) => {
        if (signError) {
          console.error('Failed to create signed URL:', signError);
          setError(signError.message);
          // Fallback to original URL (may not work if bucket is private)
          setSignedUrl(imageUrl);
        } else if (data?.signedUrl) {
          setSignedUrl(data.signedUrl);
        } else {
          setSignedUrl(imageUrl);
        }
      })
      .finally(() => {
        setLoading(false);
      });
  }, [imageUrl]);

  return { signedUrl, loading, error };
}

/**
 * Parse a storage URL to extract bucket and file path.
 * Returns null if not a valid storage reference.
 */
function parseStorageUrl(imageUrl: string): { bucket: string; filePath: string } | null {
  // Format 1: Storage path like "dumps/userId/filename.png"
  // Check if it starts with a known bucket name and contains a path
  if (imageUrl.startsWith('dumps/')) {
    const filePath = imageUrl.substring('dumps/'.length);
    if (filePath) {
      return { bucket: 'dumps', filePath };
    }
  }

  // Format 2: Full Supabase URL
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  
  // Check for public URL format
  const publicPrefix = '/storage/v1/object/public/';
  if (imageUrl.includes(supabaseUrl) && imageUrl.includes(publicPrefix)) {
    const publicIndex = imageUrl.indexOf(publicPrefix);
    const pathPart = imageUrl.substring(publicIndex + publicPrefix.length);
    const [bucket, ...pathParts] = pathPart.split('/');
    const filePath = pathParts.join('/');

    if (bucket && filePath) {
      return { bucket, filePath };
    }
  }

  // Check for signed URL format (already signed, extract for re-signing if needed)
  const signedPrefix = '/storage/v1/object/sign/';
  if (imageUrl.includes(supabaseUrl) && imageUrl.includes(signedPrefix)) {
    const signedIndex = imageUrl.indexOf(signedPrefix);
    const pathPart = imageUrl.substring(signedIndex + signedPrefix.length);
    // Remove query params (token, etc.)
    const pathWithoutParams = pathPart.split('?')[0];
    const [bucket, ...pathParts] = pathWithoutParams.split('/');
    const filePath = pathParts.join('/');

    if (bucket && filePath) {
      return { bucket, filePath };
    }
  }

  return null;
}

/**
 * Helper function to get a signed URL directly (for edge functions or one-off use)
 */
export async function getSignedUrl(imageUrl: string): Promise<string> {
  const parsed = parseStorageUrl(imageUrl);
  
  if (!parsed) {
    return imageUrl;
  }

  const { bucket, filePath } = parsed;

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(filePath, 3600);

  if (error || !data?.signedUrl) {
    console.error('Failed to create signed URL:', error);
    return imageUrl;
  }

  return data.signedUrl;
}
