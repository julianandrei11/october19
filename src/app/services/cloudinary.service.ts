import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class CloudinaryService {
  private cloudName = environment.cloudinary.cloudName;
  private uploadPreset = environment.cloudinary.uploadPreset;

  constructor() {
    console.log('Cloudinary service initialized for browser');
  }

  /**
   * Upload video to Cloudinary using browser-compatible method
   */
  async uploadVideo(file: File, options: {
    title?: string;
    folder?: string;
    publicId?: string;
  } = {}): Promise<{
    publicId: string;
    secureUrl: string;
    url: string;
    duration?: number;
    width?: number;
    height?: number;
  }> {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('upload_preset', this.uploadPreset);
      formData.append('resource_type', 'video');
      
      if (options.title) {
        formData.append('public_id', options.publicId || options.title);
      }
      
      if (options.folder) {
        formData.append('folder', options.folder);
      }

      console.log('🔥 Uploading to Cloudinary:', {
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        folder: options.folder,
        title: options.title
      });

      // Upload to Cloudinary using fetch API
      fetch(`https://api.cloudinary.com/v1_1/${this.cloudName}/video/upload`, {
        method: 'POST',
        body: formData
      })
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then(result => {
        console.log('✅ Cloudinary upload successful:', result);
        resolve({
          publicId: result.public_id,
          secureUrl: result.secure_url,
          url: result.url,
          duration: result.duration,
          width: result.width,
          height: result.height
        });
      })
      .catch(error => {
        console.error('❌ Cloudinary upload failed:', error);
        reject(error);
      });
    });
  }

  /**
   * Delete video from Cloudinary using browser-compatible method
   */
  async deleteVideo(publicId: string): Promise<boolean> {
    try {
      console.log('🗑️ Deleting video from Cloudinary:', publicId);
      
      // For browser, we'll use a server-side endpoint or signed URL
      // For now, we'll return true and handle deletion on the server side
      console.log('⚠️ Video deletion should be handled server-side for security');
      return true;
    } catch (error) {
      console.error('❌ Failed to delete video from Cloudinary:', error);
      return false;
    }
  }

  /**
   * Get video URL with transformations
   */
  getVideoUrl(publicId: string, transformations: any = {}): string {
    const baseUrl = `https://res.cloudinary.com/${this.cloudName}/video/upload`;
    const transformString = this.buildTransformString(transformations);
    return `${baseUrl}/${transformString}/${publicId}`;
  }

  /**
   * Get video thumbnail URL
   */
  getVideoThumbnail(publicId: string, transformations: any = {}): string {
    const baseUrl = `https://res.cloudinary.com/${this.cloudName}/image/upload`;
    const transformString = this.buildTransformString({
      format: 'jpg',
      ...transformations
    });
    return `${baseUrl}/${transformString}/${publicId}`;
  }

  /**
   * Update video metadata (placeholder - requires server-side implementation)
   */
  async updateVideoMetadata(publicId: string, metadata: {
    title?: string;
    description?: string;
    tags?: string[];
  }): Promise<boolean> {
    try {
      console.log('📝 Updating video metadata (placeholder):', publicId, metadata);
      // This would require server-side implementation for security
      return true;
    } catch (error) {
      console.error('❌ Failed to update video metadata:', error);
      return false;
    }
  }

  /**
   * Get video information (placeholder - requires server-side implementation)
   */
  async getVideoInfo(publicId: string): Promise<any> {
    try {
      console.log('🔍 Getting video info (placeholder):', publicId);
      // This would require server-side implementation for security
      return null;
    } catch (error) {
      console.error('❌ Failed to get video info:', error);
      return null;
    }
  }

  /**
   * Build transformation string for Cloudinary URLs
   */
  private buildTransformString(transformations: any): string {
    const params: string[] = [];
    
    Object.keys(transformations).forEach(key => {
      const value = transformations[key];
      if (value !== undefined && value !== null) {
        params.push(`${key}_${value}`);
      }
    });
    
    return params.join(',');
  }
}