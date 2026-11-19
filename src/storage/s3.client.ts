/**
 * Nạp @aws-sdk/client-s3 khi cần (optional peer dependency): lib được import thẳng vào app,
 * không bắt app nào cũng phải cài AWS SDK. Image Docker cài sẵn.
 */
export interface S3ClientConfig {
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export async function loadS3(config: S3ClientConfig) {
  let sdk: typeof import("@aws-sdk/client-s3");
  try {
    sdk = await import("@aws-sdk/client-s3");
  } catch {
    throw new Error(
      "Cần cài @aws-sdk/client-s3 để dùng S3 (npm i @aws-sdk/client-s3). Image Docker đã có sẵn.",
    );
  }
  const region = config.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  // Credential: chuỗi mặc định của SDK (ECS task role, env AWS_ACCESS_KEY_ID..., ~/.aws).
  const client = new sdk.S3Client({
    region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
  });
  return { sdk, client };
}
