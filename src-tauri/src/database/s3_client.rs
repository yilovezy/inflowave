use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::config::SharedCredentialsProvider;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::{Client, Config};
use chrono::{DateTime as ChronoDateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3ConnectionConfig {
    pub endpoint: Option<String>,
    pub region: Option<String>,
    pub access_key: String,
    pub secret_key: String,
    pub use_ssl: bool,
    pub path_style: bool,
    pub session_token: Option<String>,
    pub custom_domain: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3Object {
    pub key: String,
    pub name: String,
    pub size: i64,
    pub last_modified: ChronoDateTime<Utc>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
    pub is_directory: bool,
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3Bucket {
    pub name: String,
    pub creation_date: Option<ChronoDateTime<Utc>>,
    pub region: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ListObjectsResult {
    pub objects: Vec<S3Object>,
    pub common_prefixes: Vec<String>,
    pub is_truncated: bool,
    pub next_continuation_token: Option<String>,
    pub key_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3UploadProgress {
    pub loaded: u64,
    pub total: u64,
    pub percentage: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressEvent {
    pub status: String,
    pub downloaded_files: u32,
    pub total_files: u32,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub current_file: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3PresignedUrlResult {
    pub url: String,
    pub expires_at: ChronoDateTime<Utc>,
}

#[derive(Debug)]
pub struct S3ClientManager {
    clients: Arc<RwLock<HashMap<String, Arc<Client>>>>,
    configs: Arc<RwLock<HashMap<String, S3ConnectionConfig>>>,
}

impl S3ClientManager {
    pub fn new() -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            configs: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn create_client(&self, id: &str, config: &S3ConnectionConfig) -> Result<()> {
        // 创建AWS凭证
        let credentials = if let Some(token) = &config.session_token {
            Credentials::new(
                &config.access_key,
                &config.secret_key,
                Some(token.clone()),
                None,
                "s3-client",
            )
        } else {
            Credentials::new(
                &config.access_key,
                &config.secret_key,
                None,
                None,
                "s3-client",
            )
        };

        // 创建AWS配置
        let mut sdk_config = aws_config::defaults(BehaviorVersion::latest())
            .credentials_provider(SharedCredentialsProvider::new(credentials));

        // 设置区域
        if let Some(region) = &config.region {
            sdk_config = sdk_config.region(aws_config::Region::new(region.clone()));
        } else {
            sdk_config = sdk_config.region(aws_config::Region::new("us-east-1"));
        }

        // 创建S3客户端配置
        // 当有自定义端点时（私有化部署/MinIO/腾讯云COS等），自动启用 path style
        // 因为虚拟主机风格（bucket.endpoint）通常需要 DNS 通配符解析支持，私有部署一般不支持
        let use_path_style = if config.endpoint.is_some() && !config.path_style {
            log::info!("检测到自定义端点且未开启 path_style，自动启用 path style 以确保兼容性");
            true
        } else {
            config.path_style
        };
        let mut s3_config_builder = Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .force_path_style(use_path_style);

        // 设置自定义端点（用于MinIO等）
        if let Some(endpoint) = &config.endpoint {
            // 检查端点是否已包含协议
            let endpoint_url = if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
                // 如果已经包含协议，直接使用
                log::debug!("使用已包含协议的端点: {}", endpoint);
                endpoint.clone()
            } else {
                // 如果没有协议，根据 use_ssl 添加
                let url = if config.use_ssl {
                    format!("https://{}", endpoint)
                } else {
                    format!("http://{}", endpoint)
                };
                log::debug!("构建端点URL: {} (use_ssl: {})", url, config.use_ssl);
                url
            };
            log::info!("设置S3端点: {}", endpoint_url);
            s3_config_builder = s3_config_builder.endpoint_url(endpoint_url);
        }

        // 从SDK配置构建S3配置
        let sdk_config = sdk_config.load().await;
        s3_config_builder = s3_config_builder
            .credentials_provider(sdk_config.credentials_provider().unwrap().clone())
            .region(sdk_config.region().cloned());

        let s3_config = s3_config_builder.build();
        let client = Arc::new(Client::from_conf(s3_config));

        let mut clients = self.clients.write().await;
        clients.insert(id.to_string(), client);

        // 存储配置信息（包括 custom_domain）
        let mut configs = self.configs.write().await;
        configs.insert(id.to_string(), config.clone());

        Ok(())
    }

    pub async fn get_client(&self, id: &str) -> Result<Arc<Client>> {
        let clients = self.clients.read().await;
        clients
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("S3 client not found: {}", id))
    }

    pub async fn remove_client(&self, id: &str) -> Result<()> {
        let mut clients = self.clients.write().await;
        clients.remove(id);

        let mut configs = self.configs.write().await;
        configs.remove(id);

        Ok(())
    }

    pub async fn get_config(&self, id: &str) -> Result<S3ConnectionConfig> {
        let configs = self.configs.read().await;
        configs
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("S3 config not found: {}", id))
    }

    /// 创建一个使用自定义域名作为端点的临时S3客户端
    /// 用于生成预签名URL时确保签名与自定义域名匹配
    async fn create_presign_client(
        &self,
        config: &S3ConnectionConfig,
        custom_domain: &str,
    ) -> Result<Arc<Client>> {
        // 创建凭证
        let credentials = if let Some(token) = &config.session_token {
            Credentials::new(
                &config.access_key,
                &config.secret_key,
                Some(token.clone()),
                None,
                "s3-presign-client",
            )
        } else {
            Credentials::new(
                &config.access_key,
                &config.secret_key,
                None,
                None,
                "s3-presign-client",
            )
        };

        // 创建AWS配置
        let mut sdk_config = aws_config::defaults(BehaviorVersion::latest())
            .credentials_provider(SharedCredentialsProvider::new(credentials));

        // 设置区域
        if let Some(region) = &config.region {
            sdk_config = sdk_config.region(aws_config::Region::new(region.clone()));
        } else {
            sdk_config = sdk_config.region(aws_config::Region::new("us-east-1"));
        }

        // 清理自定义域名，移除可能的协议前缀
        let custom_domain_clean = custom_domain
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .trim_end_matches('/');

        // 根据use_ssl确定协议，构建端点URL
        let endpoint_url = if config.use_ssl {
            format!("https://{}", custom_domain_clean)
        } else {
            format!("http://{}", custom_domain_clean)
        };

        log::info!(
            "创建预签名临时客户端，使用自定义域名端点: {}",
            endpoint_url
        );

        // 创建S3客户端配置
        // 对于自定义域名，强制使用 path-style（如 https://domain.com/bucket/key）
        // 而不是 virtual-hosted-style（如 https://bucket.domain.com/key）
        // 因为自定义域名通常通过反向代理配置，不支持动态子域名方式
        let s3_config_builder = Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .force_path_style(true)
            .endpoint_url(endpoint_url);

        // 从SDK配置构建
        let sdk_config = sdk_config.load().await;
        let s3_config = s3_config_builder
            .credentials_provider(sdk_config.credentials_provider().unwrap().clone())
            .region(sdk_config.region().cloned())
            .build();

        let client = Arc::new(Client::from_conf(s3_config));
        Ok(client)
    }

    pub async fn test_connection(&self, id: &str) -> Result<bool> {
        let client = self.get_client(id).await?;

        // 注意：某些S3兼容服务（如Cloudflare R2）不支持max_buckets参数
        // 因此我们先尝试使用max_buckets=1，如果失败则回退到不带参数的list_buckets
        let resp_future = client.list_buckets().max_buckets(1).send();
        match tokio::time::timeout(std::time::Duration::from_secs(15), resp_future).await {
            Ok(Ok(_)) => {
                log::info!("S3 connection test successful (with max_buckets)");
                Ok(true)
            }
            Ok(Err(e)) => {
                log::warn!("S3 connection test with max_buckets failed: {}", e);

                // 检查是否是认证错误
                let error_msg = e.to_string();
                if error_msg.contains("InvalidAccessKeyId") || error_msg.contains("SignatureDoesNotMatch") {
                    return Err(anyhow::anyhow!("认证失败: Access Key 或 Secret Key 错误"));
                } else if error_msg.contains("AccessDenied") || error_msg.contains("403") {
                    return Err(anyhow::anyhow!("认证失败: 没有权限访问"));
                } else if error_msg.contains("credential") || error_msg.contains("Credential") {
                    return Err(anyhow::anyhow!("认证失败: 凭证配置错误"));
                }

                // 如果不是认证错误，可能是不支持max_buckets参数
                // 尝试不带max_buckets参数的list_buckets
                let resp_future2 = client.list_buckets().send();
                match tokio::time::timeout(std::time::Duration::from_secs(15), resp_future2).await {
                    Ok(Ok(_)) => {
                        log::info!("S3 connection test successful (without max_buckets)");
                        Ok(true)
                    }
                    Ok(Err(e2)) => {
                        log::error!("S3 connection test failed: {}", e2);

                        // 再次检查认证错误
                        let error_msg2 = e2.to_string();
                        if error_msg2.contains("InvalidAccessKeyId") || error_msg2.contains("SignatureDoesNotMatch") {
                            return Err(anyhow::anyhow!("认证失败: Access Key 或 Secret Key 错误"));
                        } else if error_msg2.contains("AccessDenied") || error_msg2.contains("403") {
                            return Err(anyhow::anyhow!("认证失败: 没有权限访问"));
                        } else if error_msg2.contains("credential") || error_msg2.contains("Credential") {
                            return Err(anyhow::anyhow!("认证失败: 凭证配置错误"));
                        }

                        Err(anyhow::anyhow!("连接测试失败: {}", e2))
                    }
                    Err(_) => {
                        log::error!("S3 list_buckets test timed out");
                        Err(anyhow::anyhow!("S3 连接测试请求超时，请检查网络或端点配置"))
                    }
                }
            }
            Err(_) => {
                log::error!("S3 list_buckets test with max_buckets timed out");
                Err(anyhow::anyhow!("S3 连接测试请求超时，请检查网络或端点配置"))
            }
        }
    }

    pub async fn list_buckets(&self, id: &str) -> Result<Vec<S3Bucket>> {
        let client = self.get_client(id).await?;

        let resp_future = client.list_buckets().send();
        let resp = match tokio::time::timeout(std::time::Duration::from_secs(15), resp_future).await {
            Ok(result) => result?,
            Err(_) => return Err(anyhow::anyhow!("S3 list_buckets 请求超时")),
        };

        let buckets = resp
            .buckets()
            .iter()
            .map(|b| S3Bucket {
                name: b.name().unwrap_or("").to_string(),
                creation_date: b.creation_date().map(|d| {
                    let timestamp = d.as_secs_f64();
                    ChronoDateTime::from_timestamp(timestamp as i64, 0).unwrap_or(Utc::now())
                }),
                region: None,
            })
            .collect();

        Ok(buckets)
    }

    pub async fn create_bucket(&self, id: &str, bucket_name: &str, region: Option<String>) -> Result<()> {
        let client = self.get_client(id).await?;

        let mut request = client.create_bucket().bucket(bucket_name);

        // 如果不是us-east-1区域，需要指定LocationConstraint
        if let Some(r) = region {
            if r != "us-east-1" {
                request = request.create_bucket_configuration(
                    aws_sdk_s3::types::CreateBucketConfiguration::builder()
                        .location_constraint(aws_sdk_s3::types::BucketLocationConstraint::from(r.as_str()))
                        .build(),
                );
            }
        }

        request.send().await?;
        Ok(())
    }

    pub async fn delete_bucket(&self, id: &str, bucket_name: &str) -> Result<()> {
        let client = self.get_client(id).await?;

        // 首先清空bucket
        self.empty_bucket(id, bucket_name).await?;

        // 然后删除bucket
        client.delete_bucket().bucket(bucket_name).send().await?;
        Ok(())
    }

    async fn empty_bucket(&self, id: &str, bucket_name: &str) -> Result<()> {
        let client = self.get_client(id).await?;

        // 列出所有对象
        let mut continuation_token: Option<String> = None;

        loop {
            let mut request = client
                .list_objects_v2()
                .bucket(bucket_name)
                .max_keys(1000);

            if let Some(token) = continuation_token {
                request = request.continuation_token(token);
            }

            let resp_future = request.send();
        let resp = match tokio::time::timeout(std::time::Duration::from_secs(15), resp_future).await {
            Ok(result) => result?,
            Err(_) => return Err(anyhow::anyhow!("S3 list_objects 请求超时，请检查网络或配置（若使用私有云且端点带有 bucket，请尝试开启 Path Style）")),
        };

            // 删除所有对象
            let contents = resp.contents();
            for object in contents {
                if let Some(key) = object.key() {
                    client.delete_object()
                        .bucket(bucket_name)
                        .key(key)
                        .send()
                        .await?;
                }
            }

            if !resp.is_truncated().unwrap_or(false) {
                break;
            }

            continuation_token = resp.next_continuation_token().map(|s| s.to_string());
        }

        Ok(())
    }

    pub async fn list_objects(
        &self,
        id: &str,
        bucket: &str,
        prefix: Option<String>,
        delimiter: Option<String>,
        max_keys: Option<i32>,
        continuation_token: Option<String>,
    ) -> Result<S3ListObjectsResult> {
        let client = self.get_client(id).await?;

        // 🔧 使用 V1 API 代替 V2 API，以确保更广泛的兼容性
        // (部分私有化部署的腾讯云/MinIO等在特定配置下可能会卡住V2请求)
        let mut request = client.list_objects().bucket(bucket);

        if let Some(p) = prefix {
            request = request.prefix(p);
        }

        if let Some(d) = delimiter {
            request = request.delimiter(d);
        }

        if let Some(m) = max_keys {
            request = request.max_keys(m);
        }

        if let Some(token) = continuation_token {
            request = request.marker(token);
        }

        let resp_future = request.send();
        let resp = match tokio::time::timeout(std::time::Duration::from_secs(15), resp_future).await {
            Ok(result) => result?,
            Err(_) => {
                log::error!("S3 list_objects timed out for bucket: {}", bucket);
                return Err(anyhow::anyhow!("S3 list_objects 请求超时，请检查网络或端点配置（若使用私有云，请尝试开启 Path Style）"));
            }
        };

        let objects: Vec<S3Object> = resp
            .contents()
            .iter()
            .map(|obj| {
                let key = obj.key().unwrap_or("").to_string();
                let is_directory = key.ends_with('/');

                // 对于以 / 结尾的 key（文件夹标记），先去掉尾部的 / 再提取名称
                let name = if is_directory {
                    key.trim_end_matches('/').split('/').last().unwrap_or(&key).to_string()
                } else {
                    key.split('/').last().unwrap_or(&key).to_string()
                };

                S3Object {
                    key: key.clone(),
                    name,
                    size: obj.size().unwrap_or(0),
                    last_modified: obj.last_modified().map(|d| {
                        let timestamp = d.as_secs_f64();
                        ChronoDateTime::from_timestamp(timestamp as i64, 0).unwrap_or(Utc::now())
                    }).unwrap_or(Utc::now()),
                    etag: obj.e_tag().map(|s| s.to_string()),
                    storage_class: obj.storage_class().map(|s| s.as_str().to_string()),
                    is_directory,
                    content_type: None,
                }
            })
            .collect();

        let common_prefixes = resp
            .common_prefixes()
            .iter()
            .filter_map(|p| p.prefix().map(|s| s.to_string()))
            .collect();

        // 尝试从下一个标记中获取，如果没有，则根据 S3 V1 API 规范，
        // 使用最后一个对象的 key 作为下一个 marker
        let next_marker = resp.next_marker().map(|s| s.to_string()).or_else(|| {
            if resp.is_truncated().unwrap_or(false) {
                objects.last().map(|obj: &S3Object| obj.key.clone())
            } else {
                None
            }
        });

        Ok(S3ListObjectsResult {
            objects,
            common_prefixes,
            is_truncated: resp.is_truncated().unwrap_or(false),
            next_continuation_token: next_marker,
            // V1 doesn't have key_count, so we compute it
            key_count: resp.contents().len() as i32,
        })
    }

    pub async fn upload_object(
        &self,
        id: &str,
        bucket: &str,
        key: &str,
        data: Vec<u8>,
        content_type: Option<String>,
    ) -> Result<()> {
        let client = self.get_client(id).await?;

        let mut request = client
            .put_object()
            .bucket(bucket)
            .key(key)
            .body(ByteStream::from(data));

        // 设置Content-Type
        if let Some(ct) = content_type {
            request = request.content_type(ct);
        } else {
            // 尝试从文件扩展名猜测MIME类型
            if let Some(mime) = mime_guess::from_path(key).first() {
                request = request.content_type(mime.to_string());
            }
        }

        request.send().await?;
        Ok(())
    }

    pub async fn upload_file_stream(
        &self,
        id: &str,
        bucket: &str,
        key: &str,
        file_path: &str,
        content_type: Option<String>,
    ) -> Result<()> {
        let client = self.get_client(id).await?;

        let body = ByteStream::from_path(std::path::Path::new(file_path))
            .await
            .map_err(|e| anyhow::anyhow!("Failed to read file stream from {}: {}", file_path, e))?;

        let mut request = client
            .put_object()
            .bucket(bucket)
            .key(key)
            .body(body);

        // 设置Content-Type
        if let Some(ct) = content_type {
            request = request.content_type(ct);
        } else {
            // 尝试从文件扩展名猜测MIME类型
            if let Some(mime) = mime_guess::from_path(key).first() {
                request = request.content_type(mime.to_string());
            }
        }

        request.send().await?;
        Ok(())
    }

    pub async fn download_object(
        &self,
        id: &str,
        bucket: &str,
        key: &str,
    ) -> Result<Vec<u8>> {
        let client = self.get_client(id).await?;

        let resp = client
            .get_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await?;

        let data = resp.body.collect().await?;
        Ok(data.into_bytes().to_vec())
    }

    pub async fn download_folder(
        &self,
        id: &str,
        bucket: &str,
        prefix: &str,
        local_dir: &str,
        app: tauri::AppHandle,
    ) -> Result<()> {
        use tauri::Emitter;
        use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
        use futures::stream::{self, StreamExt};

        let client = self.get_client(id).await?;
        
        // Extract the folder name from the prefix (e.g., "path/to/folder/" -> "folder")
        let folder_name = prefix.trim_end_matches('/').split('/').last().unwrap_or("");
        let base_path = std::path::Path::new(local_dir).join(folder_name);

        // Phase 1: Pre-scan
        let mut all_objects = Vec::new();
        let mut total_bytes = 0;
        let mut total_files = 0;
        
        let emit_progress = |app: &tauri::AppHandle, status: &str, d_files: u32, t_files: u32, d_bytes: u64, t_bytes: u64, curr_file: &str, err: Option<String>| {
            let _ = app.emit("s3-download-progress", DownloadProgressEvent {
                status: status.to_string(),
                downloaded_files: d_files,
                total_files: t_files,
                downloaded_bytes: d_bytes,
                total_bytes: t_bytes,
                current_file: curr_file.to_string(),
                error: err,
            });
        };

        emit_progress(&app, "scanning", 0, 0, 0, 0, "Scanning folder...", None);

        let mut marker = None;
        loop {
            let mut req = client.list_objects().bucket(bucket).prefix(prefix);
            if let Some(m) = marker.clone() {
                req = req.marker(m);
            }

            let resp = req.send().await.map_err(|e| anyhow::anyhow!("Failed to list objects: {}", e))?;
            for obj in resp.contents() {
                if let Some(obj_key) = obj.key() {
                    if obj_key.ends_with('/') {
                        continue;
                    }
                    let size = obj.size().unwrap_or(0);
                    total_bytes += size as u64;
                    total_files += 1;
                    all_objects.push((obj_key.to_string(), size as u64));
                }
            }

            if resp.is_truncated().unwrap_or(false) {
                marker = resp.next_marker().map(|s| s.to_string()).or_else(|| {
                    resp.contents().last().and_then(|obj| obj.key().map(|s| s.to_string()))
                });
            } else {
                break;
            }
        }

        // Emit ready to download
        emit_progress(&app, "downloading", 0, total_files, 0, total_bytes, "Starting download...", None);

        // Phase 2: Concurrent Download
        let downloaded_files = Arc::new(AtomicU32::new(0));
        let downloaded_bytes = Arc::new(AtomicU64::new(0));

        let stream = stream::iter(all_objects.into_iter()).map(|(obj_key, size)| {
            let client = client.clone();
            let app = app.clone();
            let base_path = base_path.to_path_buf();
            let prefix_str = prefix.to_string();
            let bucket_str = bucket.to_string();
            let downloaded_files = downloaded_files.clone();
            let downloaded_bytes = downloaded_bytes.clone();

            async move {
                let relative_path = if obj_key.starts_with(&prefix_str) {
                    &obj_key[prefix_str.len()..]
                } else {
                    &obj_key
                };

                let local_file_path = base_path.join(relative_path);

                if let Some(parent) = local_file_path.parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        return Err(anyhow::anyhow!("Failed to create dir: {}", e));
                    }
                }

                let get_resp = client
                    .get_object()
                    .bucket(&bucket_str)
                    .key(&obj_key)
                    .send()
                    .await;

                match get_resp {
                    Ok(resp) => {
                        match resp.body.collect().await {
                            Ok(data) => {
                                if let Err(e) = tokio::fs::write(&local_file_path, data.into_bytes()).await {
                                    return Err(anyhow::anyhow!("Failed to write file: {}", e));
                                }
                            }
                            Err(e) => return Err(anyhow::anyhow!("Failed to collect body: {}", e)),
                        }
                    }
                    Err(e) => return Err(anyhow::anyhow!("Failed to get object: {}", e)),
                }

                // Update progress
                let current_d_files = downloaded_files.fetch_add(1, Ordering::SeqCst) + 1;
                let current_d_bytes = downloaded_bytes.fetch_add(size, Ordering::SeqCst) + size;

                let _ = app.emit("s3-download-progress", DownloadProgressEvent {
                    status: "downloading".to_string(),
                    downloaded_files: current_d_files,
                    total_files,
                    downloaded_bytes: current_d_bytes,
                    total_bytes,
                    current_file: obj_key,
                    error: None,
                });

                Ok(())
            }
        });

        // Use buffer_unordered for concurrency (e.g. 5 concurrent downloads)
        let results: Vec<Result<()>> = stream.buffer_unordered(5).collect().await;

        let mut has_error = false;
        let mut error_messages = Vec::new();
        for res in results {
            if let Err(e) = res {
                has_error = true;
                let err_str = e.to_string();
                tracing::error!("Download error: {}", err_str);
                error_messages.push(err_str);
            }
        }

        if has_error {
            let combined_error = error_messages.join("; ");
            emit_progress(&app, "error", downloaded_files.load(Ordering::SeqCst), total_files, downloaded_bytes.load(Ordering::SeqCst), total_bytes, "", Some(combined_error.clone()));
            return Err(anyhow::anyhow!("Download folder completed with errors: {}", combined_error));
        } else {
            emit_progress(&app, "completed", total_files, total_files, total_bytes, total_bytes, "Download completed successfully", None);
        }

        Ok(())
    }

    pub async fn delete_object(
        &self,
        id: &str,
        bucket: &str,
        key: &str,
    ) -> Result<()> {
        let client = self.get_client(id).await?;

        client
            .delete_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await?;

        Ok(())
    }

    pub async fn delete_objects(
        &self,
        id: &str,
        bucket: &str,
        keys: Vec<String>,
    ) -> Result<Vec<String>> {
        let client = self.get_client(id).await?;
        let mut all_keys_to_delete = Vec::new();

        // 展开所有的文件夹
        for key in keys {
            if key.ends_with('/') {
                // 这是一个文件夹，需要列出下面所有的对象 (使用 V1 API 以保证最大兼容性)
                let mut marker = None;
                loop {
                    let mut req = client.list_objects().bucket(bucket).prefix(&key);
                    if let Some(m) = marker.clone() {
                        req = req.marker(m);
                    }
                    
                    let resp = req.send().await?;
                    for obj in resp.contents() {
                        if let Some(obj_key) = obj.key() {
                            all_keys_to_delete.push(obj_key.to_string());
                        }
                    }
                    
                    if resp.is_truncated().unwrap_or(false) {
                        marker = resp.next_marker().map(|s| s.to_string()).or_else(|| {
                            resp.contents()
                                .last()
                                .and_then(|obj| obj.key().map(|s| s.to_string()))
                        });
                    } else {
                        break;
                    }
                }
            } else {
                all_keys_to_delete.push(key);
            }
        }
        
        if all_keys_to_delete.is_empty() {
            return Ok(Vec::new());
        }

        let mut all_deleted = Vec::new();
        let mut has_error = false;
        let mut last_error = None;

        // AWS API limit is 1000 objects per delete request
        for chunk in all_keys_to_delete.chunks(1000) {
            let objects: Vec<_> = chunk
                .iter()
                .map(|k| {
                    aws_sdk_s3::types::ObjectIdentifier::builder()
                        .key(k)
                        .build()
                        .unwrap()
                })
                .collect();

            let delete = aws_sdk_s3::types::Delete::builder()
                .set_objects(Some(objects))
                .build()?;

            let resp_result = client
                .delete_objects()
                .bucket(bucket)
                .delete(delete)
                .send()
                .await;

            match resp_result {
                Ok(resp) => {
                    let deleted: Vec<String> = resp
                        .deleted()
                        .iter()
                        .filter_map(|d| d.key().map(|s| s.to_string()))
                        .collect();
                    all_deleted.extend(deleted);
                }
                Err(e) => {
                    log::warn!("Batch delete_objects failed: {}, falling back to sequential delete_object", e);
                    has_error = true;
                    last_error = Some(anyhow::anyhow!(e.to_string()));
                    for k in chunk {
                        match self.delete_object(id, bucket, k).await {
                            Ok(_) => all_deleted.push(k.to_string()),
                            Err(err) => log::error!("Fallback delete failed for {}: {}", k, err),
                        }
                    }
                }
            }
        }
        
        if all_deleted.is_empty() && has_error {
            return Err(last_error.unwrap());
        }
        
        Ok(all_deleted)
    }

    pub async fn copy_object(
        &self,
        id: &str,
        source_bucket: &str,
        source_key: &str,
        dest_bucket: &str,
        dest_key: &str,
    ) -> Result<()> {
        let client = self.get_client(id).await?;

        let copy_source = format!("{}/{}", source_bucket, source_key);

        client
            .copy_object()
            .copy_source(copy_source)
            .bucket(dest_bucket)
            .key(dest_key)
            .send()
            .await?;

        Ok(())
    }

    pub async fn move_object(
        &self,
        id: &str,
        source_bucket: &str,
        source_key: &str,
        dest_bucket: &str,
        dest_key: &str,
    ) -> Result<()> {
        // 先复制
        self.copy_object(id, source_bucket, source_key, dest_bucket, dest_key).await?;

        // 再删除原文件
        self.delete_object(id, source_bucket, source_key).await?;

        Ok(())
    }

    pub async fn create_folder(
        &self,
        id: &str,
        bucket: &str,
        folder_path: &str,
    ) -> Result<()> {
        let client = self.get_client(id).await?;

        // 确保路径以/结尾
        let key = if folder_path.ends_with('/') {
            folder_path.to_string()
        } else {
            format!("{}/", folder_path)
        };

        // 上传一个空对象作为文件夹占位符
        client
            .put_object()
            .bucket(bucket)
            .key(key)
            .body(ByteStream::from(Vec::new()))
            .send()
            .await?;

        Ok(())
    }

    pub async fn get_object_metadata(
        &self,
        id: &str,
        bucket: &str,
        key: &str,
    ) -> Result<HashMap<String, String>> {
        let client = self.get_client(id).await?;

        let resp = client
            .head_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await?;

        let mut metadata = HashMap::new();

        if let Some(content_type) = resp.content_type() {
            metadata.insert("ContentType".to_string(), content_type.to_string());
        }

        if let Some(content_length) = resp.content_length() {
            metadata.insert("ContentLength".to_string(), content_length.to_string());
        }

        if let Some(etag) = resp.e_tag() {
            metadata.insert("ETag".to_string(), etag.to_string());
        }

        if let Some(last_modified) = resp.last_modified() {
            metadata.insert("LastModified".to_string(), last_modified.to_string());
        }

        if let Some(storage_class) = resp.storage_class() {
            metadata.insert("StorageClass".to_string(), storage_class.as_str().to_string());
        }

        Ok(metadata)
    }

    pub async fn generate_presigned_url(
        &self,
        id: &str,
        bucket: &str,
        key: &str,
        operation: &str,
        expires_in_seconds: u64,
    ) -> Result<S3PresignedUrlResult> {
        let config = self.get_config(id).await?;
        let expires_in = std::time::Duration::from_secs(expires_in_seconds);

        // 如果配置了自定义域名，创建一个使用自定义域名作为端点的临时客户端
        // 这样签名会基于自定义域名计算，而不是内网端点
        let client = if let Some(ref custom_domain) = config.custom_domain {
            if !custom_domain.is_empty() {
                log::info!(
                    "使用自定义域名 {} 生成预签名URL",
                    custom_domain
                );
                self.create_presign_client(&config, custom_domain).await?
            } else {
                self.get_client(id).await?
            }
        } else {
            self.get_client(id).await?
        };

        let presigned_request = match operation {
            "get" => {
                client
                    .get_object()
                    .bucket(bucket)
                    .key(key)
                    .presigned(
                        aws_sdk_s3::presigning::PresigningConfig::expires_in(expires_in)
                            .map_err(|e| anyhow!("Failed to create presigning config: {}", e))?,
                    )
                    .await?
            }
            "put" => {
                client
                    .put_object()
                    .bucket(bucket)
                    .key(key)
                    .presigned(
                        aws_sdk_s3::presigning::PresigningConfig::expires_in(expires_in)
                            .map_err(|e| anyhow!("Failed to create presigning config: {}", e))?,
                    )
                    .await?
            }
            _ => return Err(anyhow!("Unsupported presigned URL operation: {}", operation)),
        };

        let url = presigned_request.uri().to_string();
        let expires_at = Utc::now() + chrono::Duration::seconds(expires_in_seconds as i64);

        log::info!("生成预签名URL: {}", url);

        Ok(S3PresignedUrlResult {
            url,
            expires_at,
        })
    }

    pub async fn search_objects(
        &self,
        id: &str,
        bucket: &str,
        search_term: &str,
        prefix: Option<String>,
    ) -> Result<Vec<S3Object>> {
        let mut all_objects = Vec::new();
        let mut continuation_token: Option<String> = None;

        loop {
            let result = self.list_objects(
                id,
                bucket,
                prefix.clone(),
                None,
                Some(1000),
                continuation_token,
            ).await?;

            // 过滤匹配搜索词的对象
            let filtered: Vec<S3Object> = result
                .objects
                .into_iter()
                .filter(|obj| {
                    obj.name.to_lowercase().contains(&search_term.to_lowercase()) ||
                    obj.key.to_lowercase().contains(&search_term.to_lowercase())
                })
                .collect();

            all_objects.extend(filtered);

            if !result.is_truncated {
                break;
            }

            continuation_token = result.next_continuation_token;
        }

        Ok(all_objects)
    }

    /// 获取对象标签
    pub async fn get_object_tagging(
        &self,
        id: &str,
        bucket: &str,
        key: &str,
    ) -> Result<std::collections::HashMap<String, String>> {
        let clients = self.clients.read().await;
        let client = clients
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("S3 client not found: {}", id))?;

        let resp = client
            .get_object_tagging()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .context("Failed to get object tagging")?;

        let mut tags = std::collections::HashMap::new();
        for tag in resp.tag_set() {
            tags.insert(tag.key().to_string(), tag.value().to_string());
        }

        Ok(tags)
    }

    /// 设置对象标签
    pub async fn put_object_tagging(
        &self,
        id: &str,
        bucket: &str,
        key: &str,
        tags: std::collections::HashMap<String, String>,
    ) -> Result<()> {
        let clients = self.clients.read().await;
        let client = clients
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("S3 client not found: {}", id))?;

        use aws_sdk_s3::types::{Tag, Tagging};

        let tag_set: Vec<Tag> = tags
            .into_iter()
            .map(|(k, v)| Tag::builder().key(k).value(v).build())
            .collect::<Result<Vec<_>, _>>()?;

        let tagging = Tagging::builder().set_tag_set(Some(tag_set)).build()?;

        client
            .put_object_tagging()
            .bucket(bucket)
            .key(key)
            .tagging(tagging)
            .send()
            .await
            .context("Failed to put object tagging")?;

        Ok(())
    }

    /// 获取对象ACL权限
    pub async fn get_object_acl(
        &self,
        id: &str,
        bucket: &str,
        key: &str,
    ) -> Result<String> {
        let clients = self.clients.read().await;
        let client = clients
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("S3 client not found: {}", id))?;

        let resp = client
            .get_object_acl()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .context("Failed to get object ACL")?;

        // 解析 ACL 权限，返回简化的权限字符串
        let grants = resp.grants();

        let mut has_public_read = false;
        let mut has_public_write = false;
        let mut has_public_full_control = false;
        let mut has_authenticated_read = false;

        // 调试日志：打印所有 grants
        log::debug!("Object '{}/{}' ACL grants count: {}", bucket, key, grants.len());

        for grant in grants {
            if let Some(grantee) = grant.grantee() {
                // 调试日志：打印 grantee 信息
                log::debug!(
                    "Grant - Type: {:?}, URI: {:?}, ID: {:?}, DisplayName: {:?}, Permission: {:?}",
                    grantee.r#type(),
                    grantee.uri(),
                    grantee.id(),
                    grantee.display_name(),
                    grant.permission()
                );

                if let Some(uri) = grantee.uri() {
                    if let Some(permission) = grant.permission() {
                        // 检查是否授予了所有用户（公共）权限
                        if uri.contains("AllUsers") {
                            match permission.as_str() {
                                "READ" => has_public_read = true,
                                "WRITE" => has_public_write = true,
                                "FULL_CONTROL" => has_public_full_control = true,
                                _ => {}
                            }
                        }
                        // 检查是否授予了认证用户权限
                        if uri.contains("AuthenticatedUsers") && permission.as_str() == "READ" {
                            has_authenticated_read = true;
                        }
                    }
                }
            }
        }

        // 根据权限组合返回结果
        let result = if has_public_full_control || (has_public_read && has_public_write) {
            "public-read-write".to_string()
        } else if has_public_read {
            "public-read".to_string()
        } else if has_authenticated_read {
            "authenticated-read".to_string()
        } else {
            "private".to_string()
        };

        log::debug!("Object '{}/{}' ACL result: {}", bucket, key, result);
        Ok(result)
    }

    /// 设置对象ACL权限
    pub async fn put_object_acl(
        &self,
        id: &str,
        bucket: &str,
        key: &str,
        acl: &str,
    ) -> Result<()> {
        let clients = self.clients.read().await;
        let client = clients
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("S3 client not found: {}", id))?;

        use aws_sdk_s3::types::ObjectCannedAcl;

        let acl_value = match acl {
            "private" => ObjectCannedAcl::Private,
            "public-read" => ObjectCannedAcl::PublicRead,
            "public-read-write" => ObjectCannedAcl::PublicReadWrite,
            "authenticated-read" => ObjectCannedAcl::AuthenticatedRead,
            _ => ObjectCannedAcl::Private,
        };

        client
            .put_object_acl()
            .bucket(bucket)
            .key(key)
            .acl(acl_value)
            .send()
            .await
            .context("Failed to put object ACL")?;

        Ok(())
    }

    /// 获取 bucket ACL 权限
    pub async fn get_bucket_acl(&self, id: &str, bucket: &str) -> Result<String> {
        let clients = self.clients.read().await;
        let client = clients
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("S3 client not found: {}", id))?;

        let resp = client
            .get_bucket_acl()
            .bucket(bucket)
            .send()
            .await
            .context("Failed to get bucket ACL")?;

        // 解析 ACL 权限，返回简化的权限字符串
        let grants = resp.grants();

        let mut has_public_read = false;
        let mut has_public_write = false;
        let mut has_public_full_control = false;
        let mut has_authenticated_read = false;

        // 调试日志：打印所有 grants
        log::debug!("Bucket '{}' ACL grants count: {}", bucket, grants.len());

        for grant in grants {
            if let Some(grantee) = grant.grantee() {
                // 调试日志：打印 grantee 信息
                log::debug!(
                    "Grant - Type: {:?}, URI: {:?}, ID: {:?}, DisplayName: {:?}, Permission: {:?}",
                    grantee.r#type(),
                    grantee.uri(),
                    grantee.id(),
                    grantee.display_name(),
                    grant.permission()
                );

                if let Some(uri) = grantee.uri() {
                    if let Some(permission) = grant.permission() {
                        // 检查是否授予了所有用户（公共）权限
                        if uri.contains("AllUsers") {
                            match permission.as_str() {
                                "READ" => has_public_read = true,
                                "WRITE" => has_public_write = true,
                                "FULL_CONTROL" => has_public_full_control = true,
                                _ => {}
                            }
                        }
                        // 检查是否授予了认证用户权限
                        if uri.contains("AuthenticatedUsers") && permission.as_str() == "READ" {
                            has_authenticated_read = true;
                        }
                    }
                }
            }
        }

        // 根据权限组合返回结果
        let result = if has_public_full_control || (has_public_read && has_public_write) {
            "public-read-write".to_string()
        } else if has_public_read {
            "public-read".to_string()
        } else if has_authenticated_read {
            "authenticated-read".to_string()
        } else {
            "private".to_string()
        };

        log::debug!("Bucket '{}' ACL result: {}", bucket, result);
        Ok(result)
    }

    /// 设置 bucket ACL 权限
    pub async fn put_bucket_acl(&self, id: &str, bucket: &str, acl: &str) -> Result<()> {
        let clients = self.clients.read().await;
        let client = clients
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("S3 client not found: {}", id))?;

        use aws_sdk_s3::types::BucketCannedAcl;

        let acl_value = match acl {
            "private" => BucketCannedAcl::Private,
            "public-read" => BucketCannedAcl::PublicRead,
            "public-read-write" => BucketCannedAcl::PublicReadWrite,
            "authenticated-read" => BucketCannedAcl::AuthenticatedRead,
            _ => BucketCannedAcl::Private,
        };

        client
            .put_bucket_acl()
            .bucket(bucket)
            .acl(acl_value)
            .send()
            .await
            .context("Failed to put bucket ACL")?;

        Ok(())
    }

    /// 获取 bucket policy
    pub async fn get_bucket_policy(&self, id: &str, bucket: &str) -> Result<String> {
        let clients = self.clients.read().await;
        let client = clients
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("S3 client not found: {}", id))?;

        let resp = client
            .get_bucket_policy()
            .bucket(bucket)
            .send()
            .await
            .context("Failed to get bucket policy")?;

        let policy = resp.policy().unwrap_or("");

        log::debug!("Bucket '{}' policy: {}", bucket, policy);

        // 解析 policy JSON 判断是否为公共访问
        if policy.is_empty() {
            return Ok("private".to_string());
        }

        // 简单判断：如果 policy 包含 "Principal": "*" 和 "s3:GetObject"，则为 public-read
        if policy.contains(r#""Principal":"*"#) || policy.contains(r#""Principal":{"AWS":"*"}"#) || policy.contains(r#""Principal":{"AWS":["*"]}"#) {
            if policy.contains("s3:GetObject") {
                if policy.contains("s3:PutObject") || policy.contains("s3:DeleteObject") {
                    return Ok("public-read-write".to_string());
                } else {
                    return Ok("public-read".to_string());
                }
            }
        }

        Ok("private".to_string())
    }

    /// 设置 bucket policy
    pub async fn put_bucket_policy(&self, id: &str, bucket: &str, access: &str) -> Result<()> {
        let clients = self.clients.read().await;
        let client = clients
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("S3 client not found: {}", id))?;

        let policy = match access {
            "private" => {
                // 删除 bucket policy
                client
                    .delete_bucket_policy()
                    .bucket(bucket)
                    .send()
                    .await
                    .context("Failed to delete bucket policy")?;
                return Ok(());
            }
            "public-read" => {
                format!(
                    r#"{{
  "Version": "2012-10-17",
  "Statement": [
    {{
      "Effect": "Allow",
      "Principal": {{"AWS": ["*"]}},
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::{}/*"]
    }}
  ]
}}"#,
                    bucket
                )
            }
            "public-read-write" => {
                format!(
                    r#"{{
  "Version": "2012-10-17",
  "Statement": [
    {{
      "Effect": "Allow",
      "Principal": {{"AWS": ["*"]}},
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::{}/*"]
    }}
  ]
}}"#,
                    bucket
                )
            }
            _ => {
                return Err(anyhow::anyhow!("Unsupported access level for bucket policy: {}", access));
            }
        };

        client
            .put_bucket_policy()
            .bucket(bucket)
            .policy(policy)
            .send()
            .await
            .context("Failed to put bucket policy")?;

        Ok(())
    }
}