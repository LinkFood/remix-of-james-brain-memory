import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Hook to get a signed URL for a private storage file.
 * Since the 'dumps' bucket is now private, we need signed URLs to display images.
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

    // Check if this is a Supabase storage URL that needs signing
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    if (!imageUrl.includes(supabaseUrl) || !imageUrl.includes('/storage/v1/object/public/')) {
      // Not a Supabase public URL, use as-is (could be external URL)
      setSignedUrl(imageUrl);
      return;
    }

    // Extract the bucket and path from the URL
    // URL format: https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
    const publicPrefix = '/storage/v1/object/public/';
    const publicIndex = imageUrl.indexOf(publicPrefix);
    
    if (publicIndex === -1) {
      setSignedUrl(imageUrl);
      return;
    }

    const pathPart = imageUrl.substring(publicIndex + publicPrefix.length);
    const [bucket, ...pathParts] = pathPart.split('/');
    const filePath = pathParts.join('/');

    if (!bucket || !filePath) {
      setSignedUrl(imageUrl);
      return;
    }

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
 * Helper function to get a signed URL directly (for edge functions or one-off use)
 */
export async function getSignedUrl(imageUrl: string): Promise<string> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  
  if (!imageUrl.includes(supabaseUrl) || !imageUrl.includes('/storage/v1/object/public/')) {
    return imageUrl;
  }

  const publicPrefix = '/storage/v1/object/public/';
  const publicIndex = imageUrl.indexOf(publicPrefix);
  
  if (publicIndex === -1) {
    return imageUrl;
  }

  const pathPart = imageUrl.substring(publicIndex + publicPrefix.length);
  const [bucket, ...pathParts] = pathPart.split('/');
  const filePath = pathParts.join('/');

  if (!bucket || !filePath) {
    return imageUrl;
  }

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(filePath, 3600);

  if (error || !data?.signedUrl) {
    console.error('Failed to create signed URL:', error);
    return imageUrl;
  }

  return data.signedUrl;
}
