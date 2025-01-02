import sharp from "sharp";
import { request } from "undici";
// Constants
const DEFAULT_QUALITY = 80;
const MIN_TRANSPARENT_COMPRESS_LENGTH = 50000;
const MIN_COMPRESS_LENGTH = 10000;

function redirect(req, res) {
  if (res.headersSent) {
    return;
  }

  res.setHeader('content-length', 0);
  res.removeHeader('cache-control');
  res.removeHeader('expires');
  res.removeHeader('date');
  res.removeHeader('etag');
  res.setHeader('location', encodeURI(req.params.url));
  res.status(302).end();
}

// Function to determine if compression is needed
function shouldCompress(req) {
  const { originType, originSize, webp } = req.params;

  if (!originType.startsWith("image")) return false;
  if (originSize === 0 || req.headers.range) return false;

  if (
    !webp &&
    (originType.endsWith("png") || originType.endsWith("gif")) &&
    originSize < MIN_TRANSPARENT_COMPRESS_LENGTH
  ) {
    return false;
  }

  if (webp && originSize < MIN_COMPRESS_LENGTH) return false;

  return true;
}


import fs from 'fs';
import path from 'path';
// Function to compress the image and send it directly in the response
function compress(req, res, inputStream) {
  const format = req.params.webp ? 'webp' : 'jpeg';

  // Generate a unique temporary file path in /tmp
  const outputPath = path.join('/tmp', `compressed-${Date.now()}.${format}`);

  const sharpInstance = sharp({ unlimited: true, animated: false });

  // Pipe the input stream to sharp for processing
  inputStream.pipe(sharpInstance);

  sharpInstance
    .metadata()
    .then((metadata) => {
      if (metadata.height > 16383) {
        // Resize image only if the height is greater than the limit, without enlarging
        sharpInstance.resize({ height: 16383 });
      }

      if (req.params.grayscale) {
        sharpInstance.grayscale();
      }

      // Process the image and write it to the temporary output file
      sharpInstance
        .toFormat(format, { quality: req.params.quality })
        .toFile(outputPath, (err, info) => {
          if (err || !info || res.headersSent) {
            console.error('Compression error or headers already sent:', err?.message);
            return redirect(req, res);
          }

          // Set response headers
          res.setHeader('content-type', `image/${format}`);
          res.setHeader('content-length', info.size);
          res.setHeader('x-original-size', req.params.originSize);
          res.setHeader('x-bytes-saved', req.params.originSize - info.size);

          // Create a read stream from the output file and send it in the response
          const outputStream = fs.createReadStream(outputPath);

          outputStream.on('error', (streamErr) => {
            console.error('Stream error:', streamErr.message);
            redirect(req, res);
          });

          outputStream.on('end', () => {
            // Delete the temporary file after sending
            fs.unlink(outputPath, (unlinkErr) => {
              if (unlinkErr) {
                console.error('Error deleting temporary file:', unlinkErr.message);
              }
            });
          });

          outputStream.pipe(res);
        });
    })
    .catch((err) => {
      console.error('Metadata error:', err.message);
      redirect(req, res);
    });
}


/*import fs from 'fs';
import path from 'path';


function compress(req, res, input) {
  const format = req.params.webp ? "webp" : "jpeg"; // Format based on params
  const tempFilePath = path.join('/tmp', `output.${format}`); // Temporary file path

  const sharpInstance = sharp({ unlimited: true, animated: false });

  // Error handling for the input stream
  input.on("error", () => redirect(req, res)); // Redirect if input stream fails

  // Write chunks of input to sharp instance
  input.on("data", (chunk) => sharpInstance.write(chunk));

  // Process the image after the input stream ends
  input.on("end", () => {
    sharpInstance.end();

    // Fetch metadata and apply transformations
    sharpInstance
      .metadata()
      .then((metadata) => {
        // Resize if height exceeds the limit
        if (metadata.height > 16383) {
          sharpInstance.resize({ height: 16383 });
        }

        // Apply grayscale if requested
        if (req.params.grayscale) {
          sharpInstance.grayscale();
        }

        // Set format, quality, and compression level
        sharpInstance
          .toFormat(format, {
            quality: req.params.quality || 80, // Default quality 80
            effort: 0, // Balance performance and compression
          })
          .toFile(tempFilePath) // Save to a temporary file

          // After the image is written to the temporary file, stream it to the response
          .then((info) => {
            // Set response headers
            res.setHeader("Content-Type", `image/${format}`);
            res.setHeader("Content-Length", info.size);
            res.setHeader("X-Original-Size", req.params.originSize);
            res.setHeader("X-Bytes-Saved", req.params.originSize - info.size);
            res.statusCode = 200;

            // Create a file stream and pipe it to the response
            const fileStream = fs.createReadStream(tempFilePath);

            fileStream.on('error', () => redirect(req, res)); // Handle file stream errors

            fileStream.pipe(res); // Directly stream the file to the response

            // Clean up the temporary file after the response ends
            fileStream.on('end', () => {
              fs.unlink(tempFilePath, (err) => {
                if (err) {
                  console.error('Error deleting temporary file:', err);
                }
              });
            });
          })
          .catch((err) => {
            console.error('Error during image processing:', err.message);
            redirect(req, res); // Handle processing errors
          });
      })
      .catch(() => {
        console.error('Error fetching metadata');
        redirect(req, res); // Handle metadata errors
      });
  });
}*/


// Function to handle the request
function handleRequest(req, res, origin) {
  if (shouldCompress(req)) {
    compress(req, res, origin.data);
  } else {
    res.setHeader("X-Proxy-Bypass", 1);

    ["accept-ranges", "content-type", "content-length", "content-range"].forEach((header) => {
      if (origin.headers[header]) {
        res.setHeader(header, origin.headers[header]);
      }
    });

    origin.data.pipe(res);
  }
}



export async function fetchImageAndHandle(req, res) {
  const url = req.query.url;
  if (!url) {
    return res.send("bandwidth-hero-proxy");
  }

  req.params = {
    url: decodeURIComponent(url),
    webp: !req.query.jpeg,
    grayscale: req.query.bw != 0,
    quality: parseInt(req.query.l, 10) || DEFAULT_QUALITY,
  };

  try {
    const { statusCode, headers, body } = await request(req.params.url);

    if (statusCode >= 400) {
      res.statusCode = statusCode;
      return res.end("Failed to fetch the image.");
    }

    req.params.originType = headers["content-type"];
    req.params.originSize = parseInt(headers["content-length"], 10) || 0;

    const origin = {
      headers,
      data: body,
    };

    handleRequest(req, res, origin);
  } catch (error) {
    console.error("Error fetching image:", error.message);
    res.statusCode = 500;
    res.end("Failed to fetch the image.");
  }
}
