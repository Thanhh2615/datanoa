using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

internal static class DatanoaSshAskpass
{
    private static readonly Regex HostPromptRe = new Regex(
        @"(?:continue connecting|fingerprint|\(yes/no|are you sure|host key)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    );

    private static readonly Regex PasswordPromptRe = new Regex(
        @"\bpassword\s*:?\s*$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    );

    private static readonly Regex PassphrasePromptRe = new Regex(
        @"\bpassphrase\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    );

    private static readonly Regex DisallowedPasswordWordsRe = new Regex(
        @"\b(?:passphrase|verification|passcode|otp|token|pin|one-time)\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    );

    private static readonly Regex UserAtHostPrefixRe = new Regex(
        @"^[^\s:]+@[^\s:]+'s\s+",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    );

    private static int Main(string[] args)
    {
        if (args == null || args.Length == 0)
        {
            return 1;
        }

        string prompt = string.Join(" ", args).Trim();
        if (prompt.Length == 0)
        {
            return 1;
        }

        if (HostPromptRe.IsMatch(prompt))
        {
            return 1;
        }

        string mode = (Environment.GetEnvironmentVariable("DATANOA_SSH_AUTH_MODE") ?? string.Empty)
            .Trim()
            .ToLowerInvariant();

        if (mode == "password")
        {
            string promptBody = UserAtHostPrefixRe.Replace(prompt, string.Empty, 1);
            if (DisallowedPasswordWordsRe.IsMatch(promptBody) || !PasswordPromptRe.IsMatch(prompt))
            {
                return 1;
            }
        }
        else if (mode == "passphrase")
        {
            if (!PassphrasePromptRe.IsMatch(prompt))
            {
                return 1;
            }
        }
        else
        {
            return 1;
        }

        string secret = Environment.GetEnvironmentVariable("DATANOA_SSH_SECRET");
        if (string.IsNullOrEmpty(secret))
        {
            return 1;
        }

        byte[] utf8 = new UTF8Encoding(false).GetBytes(secret);
        using (Stream stdout = Console.OpenStandardOutput())
        {
            stdout.Write(utf8, 0, utf8.Length);
            stdout.Flush();
        }
        return 0;
    }
}
