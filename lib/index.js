"use strict";

const _ = require("lodash");
const { Storage } = require("@google-cloud/storage");
const trimParam = (str) => (typeof str === "string" ? str.trim() : undefined);
const Jimp = require("jimp");

/**
 * Load config from environment variable (if provided)
 * @param config
 * @returns {*}
 */
const checkConfig = (config) => {
  let newConfig = config;

  if (strapi.config.gcs) {
    if (strapi.config.gcs.serviceAccount) {
      config.serviceAccount = trimParam(strapi.config.gcs.serviceAccount);
    }
    if (strapi.config.gcs.bucketName) {
      config.bucketName = trimParam(strapi.config.gcs.bucketName);
    }
    if (strapi.config.gcs.bucketLocation) {
      config.bucketLocation = trimParam(strapi.config.gcs.bucketLocation);
    }
    if (strapi.config.gcs.baseUrl) {
      config.baseUrl = trimParam(strapi.config.gcs.baseUrl);
    }
  }

  return newConfig;
};

/**
 * Check validity of Service Account configuration
 * @param config
 * @returns {{private_key}|{client_email}|{project_id}|any}
 */
const checkServiceAccount = (config) => {
  if (!config.serviceAccount) {
    throw new Error('"Service Account JSON" is required!');
  }
  if (!config.bucketName) {
    throw new Error('"Multi-Regional Bucket name" is required!');
  }
  try {
    const serviceAccount = JSON.parse(config.serviceAccount);
    /**
     * Check exist
     */
    if (!serviceAccount.project_id) {
      throw new Error(
        'Error parsing data "Service Account JSON". Missing "project_id" field in JSON file.'
      );
    }
    if (!serviceAccount.client_email) {
      throw new Error(
        'Error parsing data "Service Account JSON". Missing "client_email" field in JSON file.'
      );
    }
    if (!serviceAccount.private_key) {
      throw new Error(
        'Error parsing data "Service Account JSON". Missing "private_key" field in JSON file.'
      );
    }
    return serviceAccount;
  } catch (e) {
    throw new Error(
      'Error parsing data "Service Account JSON", please be sure to copy/paste the full JSON file.'
    );
  }
};

/**
 * Check bucket exist, or create it
 * @param GCS
 * @param bucketName
 * @param bucketLocation
 * @returns {Promise<void>}
 */
const checkBucket = async (GCS, bucketName, bucketLocation) => {
  let bucket = GCS.bucket(bucketName);
  await bucket.exists().then((data) => {
    if (!data[0]) {
      try {
        GCS.createBucket(bucketName, {
          location: bucketLocation,
          storageClass: "multi_regional",
        }).then((data) => {
          strapi.log.debug(`Bucket ${bucketName} successfully created.`);
        });
      } catch (e) {
        throw new Error(
          'An error occurs when we try to create the Bucket "' +
            bucketName +
            '". Please try again on Google Cloud Platform directly.'
        );
      }
    }
  });
};

/**
 *
 * @type {{init: (function(*=): {upload: (function(*): Promise<any>)}), checkServiceAccount: module.exports.checkServiceAccount, provider: string, auth: {bucketName: {label: string, type: string}, bucketLocation: {values: string[], label: string, type: string}, serviceAccount: {label: string, type: string}, baseUrl: {values: string[], label: string, type: string}}}, checkBucket: module.exports.checkBucket, name: string}}
 */
module.exports = {
  provider: "google-cloud-storage",
  name: "Google Cloud Storage",
  auth: {
    serviceAccount: {
      label: "Service Account JSON",
      type: "textarea",
    },
    bucketName: {
      label: "Multi-Regional Bucket Name",
      type: "text",
    },
    bucketLocation: {
      label: "Multi-Regional location",
      type: "enum",
      values: ["asia", "eu", "us"],
    },
    baseUrl: {
      label:
        "Use bucket name as base URL (https://cloud.google.com/storage/docs/domain-name-verification)",
      type: "enum",
      values: [
        "https://storage.googleapis.com/{bucket-name}",
        "https://{bucket-name}",
        "http://{bucket-name}",
      ],
    },
  },
  init: (config) => {
    config = checkConfig(config);
    const serviceAccount = checkServiceAccount(config);
    const GCS = new Storage({
      projectId: serviceAccount.project_id,
      credentials: {
        client_email: serviceAccount.client_email,
        private_key: serviceAccount.private_key,
      },
    });

    return {
      upload: (file) => {
        return new Promise((resolve, reject) => {
          const backupPath =
            file.related && file.related.length > 0 && file.related[0].ref
              ? `${file.related[0].ref}`
              : `${file.hash}`;
          const filePath = file.path ? `${file.path}/` : `${backupPath}/`;
          const fileName = file.hash + file.ext.toLowerCase();
          const fileNameLG = file.hash + "LG" + file.ext.toLowerCase();
          const fileNameMD = file.hash + "MD" + file.ext.toLowerCase();
          const fileNameSM = file.hash + "SM" + file.ext.toLowerCase();
          const fileNameThumb = file.hash + "Thumb" + file.ext.toLowerCase();

          const getMimeType = (ext) => {
            return ext === ".png"
              ? Jimp.MIME_PNG
              : [".jpg", ".jpeg"].includes(ext)
              ? Jimp.MIME_JPEG
              : ext === ".bmp"
              ? Jimp.MIME_BMP
              : ext === ".tiff"
              ? Jimp.MIME_TIFF
              : Jimp.MIME_GIF;
          };

          checkBucket(GCS, config.bucketName, config.bucketLocation)
            .then(() => {
              /**
               * Check if the file already exist and force to remove it on Bucket
               */
              GCS.bucket(config.bucketName)
                .file(`${filePath}${fileName}`)
                .exists()
                .then((exist) => {
                  if (exist[0]) {
                    strapi.log.info("File already exist, try to remove it.");
                    const fileName = `${file.url.replace(
                      config.baseUrl.replace(
                        "{bucket-name}",
                        config.bucketName
                      ) + "/",
                      ""
                    )}`;

                    GCS.bucket(config.bucketName)
                      .file(`${fileName}`)
                      .delete()
                      .then(() => {
                        strapi.log.debug(
                          `File ${fileName} successfully deleted`
                        );
                      })
                      .catch((error) => {
                        if (error.code === 404) {
                          return strapi.log.warn(
                            "Remote file was not found, you may have to delete manually."
                          );
                        }
                      });
                  }
                });
            })
            .then(() => {
              if (
                [".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".gif"].includes(
                  file.ext
                )
              ) {
                return new Promise((resolve) => {
                  Jimp.read(file.buffer, (err, image) => {
                    if (err) {
                      return resolve();
                    }

                    return resolve(image);
                  });
                });
              } else {
                return new Promise.resolve();
              }
            })
            .then((image) => {
              if (!!image) {
                const mimeType = getMimeType(file.ext);

                return Promise.all([
                  new Promise((resolve) => {
                    const newImage = image.clone();
                    const imageLG =
                      newImage.bitmap &&
                      (newImage.bitmap.width > 1024 ||
                        newImage.bitmap.height > 768)
                        ? newImage.scaleToFit(1024, 768).quality(85)
                        : newImage.quality(85);

                    imageLG.getBuffer(mimeType, (err, buffer) => {
                      if (err) {
                        resolve();
                      }

                      GCS.bucket(config.bucketName)
                        .file(`${filePath}${fileNameLG}`)
                        .save(buffer, {
                          contentType: file.mime,
                          public: true,
                          metadata: {
                            contentDisposition: `inline; filename="${file.name}"`,
                          },
                        })
                        .then(() => {
                          file.urlLG = `${config.baseUrl.replace(
                            /{bucket-name}/,
                            config.bucketName
                          )}/${filePath}${fileNameLG}`;
                          strapi.log.debug(
                            `File successfully uploaded to ${file.urlLG}`
                          );
                          resolve();
                        })
                        .catch((error) => {
                          console.warn(error);
                          resolve();
                        });
                    });
                  }),
                  new Promise((resolve) => {
                    const newImage = image.clone();
                    const imageMD =
                      newImage.bitmap &&
                      (newImage.bitmap.width > 640 ||
                        newImage.bitmap.height > 480)
                        ? newImage.scaleToFit(640, 480).quality(85)
                        : newImage.quality(85);

                    imageMD.getBuffer(mimeType, (err, buffer) => {
                      if (err) {
                        resolve();
                      }

                      GCS.bucket(config.bucketName)
                        .file(`${filePath}${fileNameMD}`)
                        .save(buffer, {
                          contentType: file.mime,
                          public: true,
                          metadata: {
                            contentDisposition: `inline; filename="${file.name}"`,
                          },
                        })
                        .then(() => {
                          file.urlMD = `${config.baseUrl.replace(
                            /{bucket-name}/,
                            config.bucketName
                          )}/${filePath}${fileNameMD}`;
                          strapi.log.debug(
                            `File successfully uploaded to ${file.url}`
                          );
                          resolve();
                        })
                        .catch((error) => {
                          resolve();
                        });
                    });
                  }),
                  new Promise((resolve) => {
                    const newImage = image.clone();
                    const imageSM =
                      newImage.bitmap &&
                      (newImage.bitmap.width > 320 ||
                        newImage.bitmap.height > 240)
                        ? newImage.scaleToFit(320, 240).quality(85)
                        : newImage.quality(85);

                    imageSM.getBuffer(mimeType, (err, buffer) => {
                      if (err) {
                        resolve();
                      }

                      GCS.bucket(config.bucketName)
                        .file(`${filePath}${fileNameSM}`)
                        .save(buffer, {
                          contentType: file.mime,
                          public: true,
                          metadata: {
                            contentDisposition: `inline; filename="${file.name}"`,
                          },
                        })
                        .then(() => {
                          file.urlSM = `${config.baseUrl.replace(
                            /{bucket-name}/,
                            config.bucketName
                          )}/${filePath}${fileNameSM}`;
                          strapi.log.debug(
                            `File successfully uploaded to ${file.urlSM}`
                          );
                          resolve();
                        })
                        .catch((error) => {
                          resolve();
                        });
                    });
                  }),
                  new Promise((resolve) => {
                    const newImage = image.clone();
                    const imageThumb =
                      newImage.bitmap &&
                      (newImage.bitmap.width > 100 ||
                        newImage.bitmap.height > 100)
                        ? newImage.scaleToFit(100, 100).quality(85)
                        : newImage.quality(85);

                    imageThumb.getBuffer(mimeType, (err, buffer) => {
                      if (err) {
                        resolve();
                      }

                      GCS.bucket(config.bucketName)
                        .file(`${filePath}${fileNameThumb}`)
                        .save(buffer, {
                          contentType: file.mime,
                          public: true,
                          metadata: {
                            contentDisposition: `inline; filename="${file.name}"`,
                          },
                        })
                        .then(() => {
                          file.urlThumb = `${config.baseUrl.replace(
                            /{bucket-name}/,
                            config.bucketName
                          )}/${filePath}${fileNameThumb}`;
                          strapi.log.debug(
                            `File successfully uploaded to ${file.urlThumb}`
                          );
                          resolve();
                        })
                        .catch((error) => {
                          resolve();
                        });
                    });
                  }),
                ])
                  .then(() => {
                    return Promise.resolve(image);
                  })
                  .catch((error) => {
                    return Promise.resolve(image);
                  });
              } else {
                return Promise.resolve(image);
              }
            })
            .then((image) => {
              if (image) {
                const newImage = image.clone();
                const originalImage =
                  newImage.bitmap &&
                  (newImage.bitmap.width > 1024 ||
                    newImage.bitmap.height > 1024)
                    ? newImage.scaleToFit(1024, 1024).quality(85)
                    : newImage.quality(85);
                const mimeType = getMimeType(file.ext);

                originalImage.getBuffer(mimeType, (err, buffer) => {
                  if (err) {
                    resolve();
                  }

                  GCS.bucket(config.bucketName)
                    .file(`${filePath}${fileName}`)
                    .save(buffer, {
                      contentType: file.mime,
                      public: true,
                      metadata: {
                        contentDisposition: `inline; filename="${file.name}"`,
                      },
                    })
                    .then(() => {
                      file.url = `${config.baseUrl.replace(
                        /{bucket-name}/,
                        config.bucketName
                      )}/${filePath}${fileName}`;
                      strapi.log.debug(
                        `File successfully uploaded to ${file.url}`
                      );
                      resolve();
                    })
                    .catch((error) => {
                      resolve();
                    });
                });
              } else {
                GCS.bucket(config.bucketName)
                  .file(`${filePath}${fileName}`)
                  .save(file.buffer, {
                    contentType: file.mime,
                    public: true,
                    metadata: {
                      contentDisposition: `inline; filename="${file.name}"`,
                    },
                  })
                  .then(() => {
                    file.url = `${config.baseUrl.replace(
                      /{bucket-name}/,
                      config.bucketName
                    )}/${filePath}${fileName}`;
                    strapi.log.debug(
                      `File successfully uploaded to ${file.url}`
                    );
                    resolve();
                  })
                  .catch((error) => {
                    return reject(error);
                  });
              }
            });
        });
      },
      delete: (file) => {
        return new Promise((resolve, reject) => {
          const fileName = `${file.url.replace(
            config.baseUrl.replace("{bucket-name}", config.bucketName) + "/",
            ""
          )}`;

          GCS.bucket(config.bucketName)
            .file(fileName)
            .delete()
            .then(() => {
              strapi.log.debug(`File ${fileName} successfully deleted`);
            })
            .catch((error) => {
              if (error.code === 404) {
                return strapi.log.warn(
                  "Remote file was not found, you may have to delete manually."
                );
              }
              reject(error);
            });
          resolve();
        });
      },
    };
  },
};
