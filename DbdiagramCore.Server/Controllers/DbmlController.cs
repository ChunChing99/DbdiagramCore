using Microsoft.AspNetCore.Mvc;

namespace DbdiagramCore.Server.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class DbmlController : ControllerBase
    {
        private readonly string _folder;

        public DbmlController(IWebHostEnvironment env)
        {
            _folder = Path.Combine(env.ContentRootPath, "Dbml");
        }

        public record SaveRequest(string Name, string Content);

        /// <summary>已儲存的專案名稱，最近修改的在前。</summary>
        [HttpGet]
        public IEnumerable<string> List()
        {
            if (!Directory.Exists(_folder)) return [];
            return new DirectoryInfo(_folder).GetFiles("*.dbml")
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .Select(f => Path.GetFileNameWithoutExtension(f.Name));
        }

        /// <summary>取得 Dbml/{name}.dbml 的內容。</summary>
        [HttpGet("{name}")]
        public async Task<IActionResult> Get(string name)
        {
            var safe = SanitizeFileName(name);
            if (safe.Length == 0) return BadRequest("無效的專案名稱");
            var path = Path.Combine(_folder, safe + ".dbml");
            if (!System.IO.File.Exists(path)) return NotFound();
            return Content(await System.IO.File.ReadAllTextAsync(path), "text/plain; charset=utf-8");
        }

        /// <summary>將 DBML 原始碼存成 Dbml/{Name}.dbml。</summary>
        [HttpPost]
        public async Task<IActionResult> Save([FromBody] SaveRequest req)
        {
            var name = SanitizeFileName(req.Name);
            if (name.Length == 0) return BadRequest("無效的專案名稱");

            Directory.CreateDirectory(_folder);
            var path = Path.Combine(_folder, name + ".dbml");
            await System.IO.File.WriteAllTextAsync(path, req.Content ?? string.Empty);
            return Ok(new { file = Path.GetFileName(path) });
        }

        /// <summary>刪除 Dbml/{name}.dbml。</summary>
        [HttpDelete("{name}")]
        public IActionResult Delete(string name)
        {
            var safe = SanitizeFileName(name);
            if (safe.Length == 0) return BadRequest("無效的專案名稱");
            var path = Path.Combine(_folder, safe + ".dbml");
            if (!System.IO.File.Exists(path)) return NotFound();
            System.IO.File.Delete(path);
            return NoContent();
        }

        public record RenameRequest(string NewName);

        /// <summary>將 Dbml/{name}.dbml 改名為 Dbml/{NewName}.dbml。</summary>
        [HttpPost("{name}/rename")]
        public IActionResult Rename(string name, [FromBody] RenameRequest req)
        {
            var from = SanitizeFileName(name);
            var to = SanitizeFileName(req.NewName);
            if (from.Length == 0 || to.Length == 0) return BadRequest("無效的專案名稱");

            var fromPath = Path.Combine(_folder, from + ".dbml");
            var toPath = Path.Combine(_folder, to + ".dbml");
            if (!System.IO.File.Exists(fromPath)) return NotFound();
            if (from == to) return Ok(new { file = Path.GetFileName(toPath) });
            // a case-only change is the same file on Windows
            var sameFile = string.Equals(from, to, StringComparison.OrdinalIgnoreCase);
            if (!sameFile && System.IO.File.Exists(toPath)) return Conflict($"專案「{to}」已存在");

            System.IO.File.Move(fromPath, toPath);
            return Ok(new { file = Path.GetFileName(toPath) });
        }

        private static string SanitizeFileName(string? name)
        {
            if (string.IsNullOrWhiteSpace(name)) return string.Empty;
            var invalid = Path.GetInvalidFileNameChars();
            var chars = name.Trim().Select(c => invalid.Contains(c) ? '_' : c).ToArray();
            return new string(chars).Trim('.', ' ');
        }
    }
}
