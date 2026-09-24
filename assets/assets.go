// Package assets 嵌入前端静态资源到二进制的单一可部署单元。
package assets

import "embed"

//go:embed all:css
//go:embed all:js
//go:embed all:vendor
//go:embed index.html
var FS embed.FS