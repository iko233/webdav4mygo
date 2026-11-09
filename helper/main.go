// cover writes one validated, content-addressed cover into the plugin cache.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"time"
)

const maxImageBytes = 1024 * 1024
const maxCacheBytes = 128 * maxImageBytes

func main() {
	if len(os.Args) != 2 || !filepath.IsAbs(os.Args[1]) {
		os.Exit(1)
	}
	if err := saveCover(filepath.Join(os.Args[1], "cover-cache")); err != nil {
		os.Exit(1)
	}
}

func saveCover(dir string) error {
	input := base64.NewDecoder(base64.StdEncoding, os.Stdin)
	contents, err := io.ReadAll(io.LimitReader(input, maxImageBytes+1))
	if err != nil {
		return err
	}
	if len(contents) > maxImageBytes {
		return fmt.Errorf("cover exceeds byte limit")
	}
	info, format, err := image.DecodeConfig(bytes.NewReader(contents))
	if err != nil {
		return err
	}
	if info.Width <= 0 || info.Height <= 0 || info.Width > 4096 || info.Height > 4096 {
		return fmt.Errorf("invalid cover dimensions")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	path := filepath.Join(dir, fmt.Sprintf("%x.%s", sha256.Sum256(contents), format))
	if err := writeCover(path, contents); err != nil {
		return err
	}
	prune(dir)
	slashPath := filepath.ToSlash(path)
	if runtime.GOOS == "windows" {
		slashPath = "/" + slashPath
	}
	fmt.Println((&url.URL{Scheme: "file", Path: slashPath}).String())
	return nil
}

func writeCover(path string, contents []byte) error {
	now := time.Now()
	if os.Chtimes(path, now, now) == nil {
		return nil
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".cover-")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	_, writeErr := temp.Write(contents)
	closeErr := temp.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(temp.Name(), path); err != nil {
		// Another scan may have written the same content first.
		if _, statErr := os.Stat(path); statErr != nil {
			return err
		}
	}
	return nil
}

func prune(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var files []os.FileInfo
	var size int64
	for _, entry := range entries {
		name := entry.Name()
		if len(name) < 65 || name[64] != '.' || !entry.Type().IsRegular() {
			continue
		}
		if info, err := entry.Info(); err == nil {
			files = append(files, info)
			size += info.Size()
		}
	}
	if size <= maxCacheBytes {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].ModTime().Before(files[j].ModTime()) })
	for _, file := range files {
		if size <= maxCacheBytes {
			return
		}
		if os.Remove(filepath.Join(dir, file.Name())) == nil {
			size -= file.Size()
		}
	}
}
