import https from 'https';
import sharp from 'sharp';

// Constantsu
const DEFAULT_QUALITY = 80;
const MAX_HEIGHT = 16383; // Resize if height exceeds this value

// Utility function to determine if compression is needed
function shouldCompress(originType, originSize, isWebp) {
  const MIN_COMPRESS_LENGTH = isWebp ? 10000 : 50000;
  return (
    originType.startsWith("image") &&
    originSize >= MIN_COMPRESS_LENGTH &&
    !originType.endsWith("gif") // Skip GIFs for simplicity
  );
}

// Function to compress an image stream directly
sharp.cache(false);
sharp.simd(true);
sharp.concurrency(1);
function compressStream(inputStream, format, quality, grayscale, res, originSize) {
  const sharpInstance = sharp({ unlimited: false, animated: false });

  inputStream.pipe(sharpInstance);

  sharpInstance
    .metadata()
    .then((metadata) => {
      if (metadata.height > MAX_HEIGHT) {
        sharpInstance.resize({ height: MAX_HEIGHT });
      }

      if (grayscale) {
        sharpInstance.grayscale();
      }

      // Set headers for the compressed image
      res.setHeader("Content-Type", `image/${format}`);

      sharpInstance
        .toFormat(format, { quality, effort: 0 })
        .on("data", (chunk) => {
          const buffer = Buffer.from(chunk); // Convert the chunk to a buffer
          res.write(buffer);
        })
        .on("info", (info) => {
          res.setHeader("X-Original-Size", originSize);
        })
        .on("end", () => {
          res.end(); // Finalize the response
        })
        .on("error", (err) => {
          console.error("Error during compression:", err.message);
          res.status(500).send("Error processing image.");
        });
    })
    .catch((err) => {
      console.error("Error fetching metadata:", err.message);
      res.status(500).send("Error processing image metadata.");
    });
}

// Function to handle image compression requests
export function fetchImageAndHandle(req, res) {
  const imageUrl = req.query.url;
  const isWebp = !req.query.jpeg;
  const grayscale = req.query.bw == "1";
  const quality = parseInt(req.query.quality, 10) || DEFAULT_QUALITY;
  const format = isWebp ? "webp" : "jpeg";

  if (!imageUrl) {
    return res.status(400).end("Image URL is required.");
  }

  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36', // Neutral User-Agent
      'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8', // Accept headers for images
      'Accept-Language': 'en-US,en;q=0.9', // Language preference
      'Accept-Encoding': 'gzip, deflate, br', // Common encoding
    },
  };

  https.get(imageUrl, options, (response) => {
    const originType = response.headers["content-type"];
    const originSize = parseInt(response.headers["content-length"], 10) || 0;

    if (response.statusCode >= 400) {
      return res.status(response.statusCode).send("Failed to fetch the image.");
    }

    if (shouldCompress(originType, originSize, isWebp)) {
      // Compress the stream
      compressStream(response, format, quality, grayscale, res, originSize);
    } else {
      // Stream the original image to the response if compression is not needed
      res.setHeader("Content-Type", originType);
      res.setHeader("Content-Length", originSize);
      response.pipe(res);
    }
  }).on("error", (error) => {
    console.error("Error fetching image:", error.message);
    res.status(500).end("Failed to fetch the image.");
  });
}
