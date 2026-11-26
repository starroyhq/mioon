#import <Foundation/Foundation.h>

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

enum {
    WireVersion = 1,
    MaxPayload = 1024 * 1024,
    MaxDescriptor = 16 * 1024,
    FrameHeader = 5,
    InputChunk = 64 * 1024,
    HandshakeMs = 5000,
    CancelMs = 2000,
    UnavailableExit = 4,
};

enum FrameType {
    Stdin = 1, StdinEOF, Stdout, Stderr, Cancel, Exit, Ready, Error,
};

static NSString *const LauncherVersion = @MIOON_LAUNCHER_VERSION;
static NSString *const Channel = @MIOON_LAUNCHER_CHANNEL;
static NSString *const AppID = @MIOON_LAUNCHER_APP_ID;
static NSString *const Unavailable = @"CLI_RUNTIME_UNAVAILABLE";
static NSString *const ProtocolError = @"CLI_PROTOCOL_ERROR";
static NSString *const VersionMismatch = @"CLI_VERSION_MISMATCH";

static volatile sig_atomic_t interrupted;
static volatile sig_atomic_t signalWriter = -1;

static void interruptHandler(int signalNumber) {
    const int saved = errno;
    const uint8_t wake = 1;
    if (interrupted == 0 || signalNumber == SIGTERM) interrupted = signalNumber;
    if (signalWriter >= 0) {
        ssize_t ignored = write(signalWriter, &wake, sizeof(wake));
        (void)ignored;
    }
    errno = saved;
}

static bool setupSignals(int wake[2]) {
    if (pipe(wake) != 0) return false;
    for (int i = 0; i < 2; i++) {
        if (fcntl(wake[i], F_SETFL, O_NONBLOCK) < 0 || fcntl(wake[i], F_SETFD, FD_CLOEXEC) < 0) return false;
    }
    struct sigaction ignore = {.sa_handler = SIG_IGN};
    struct sigaction cancel = {.sa_handler = interruptHandler};
    sigemptyset(&ignore.sa_mask);
    sigemptyset(&cancel.sa_mask);
    signalWriter = wake[1];
    return sigaction(SIGPIPE, &ignore, NULL) == 0
        && sigaction(SIGINT, &cancel, NULL) == 0
        && sigaction(SIGTERM, &cancel, NULL) == 0;
}

static int signalExit(void) {
    return 128 + interrupted;
}

static bool ensureStandardDescriptors(void) {
    // Keep internal sockets and wakeups out of the standard descriptor range.
    for (int fd = STDIN_FILENO; fd <= STDERR_FILENO; fd++) {
        if (fcntl(fd, F_GETFD) >= 0) continue;
        if (errno != EBADF || open("/dev/null", O_RDWR) != fd) return false;
    }
    return true;
}

static bool writeOutput(int fd, NSData *bytes) {
    for (NSUInteger offset = 0; offset < bytes.length;) {
        ssize_t count = write(fd, (const uint8_t *)bytes.bytes + offset, bytes.length - offset);
        if (count < 0 && errno == EINTR && !interrupted) continue;
        if (count <= 0) return false;
        offset += (NSUInteger)count;
    }
    return true;
}

static bool printJSON(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    if (data == nil) return false;
    NSMutableData *line = [data mutableCopy];
    [line appendBytes:"\n" length:1];
    return writeOutput(STDOUT_FILENO, line);
}

static bool chinese(void) {
    const char *const keys[] = {"LC_ALL", "LC_MESSAGES", "LANG"};
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
        const char *value = getenv(keys[i]);
        if (value != NULL && *value != '\0') return strncasecmp(value, "zh", 2) == 0;
    }
    return [NSLocale.preferredLanguages.firstObject hasPrefix:@"zh"];
}

static bool asciiLetterOrDigit(unsigned char c) {
    return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

static bool validVersion(id value) {
    if (![value isKindOfClass:[NSString class]]) return false;
    NSString *version = value;
    const char *bytes = version.UTF8String;
    if (bytes == NULL || version.length == 0 || version.length > 64 || strlen(bytes) != version.length
        || !asciiLetterOrDigit((unsigned char)bytes[0])) return false;
    for (NSUInteger i = 1; i < version.length; i++) {
        if (!asciiLetterOrDigit((unsigned char)bytes[i]) && strchr("._+-", bytes[i]) == NULL) return false;
    }
    return true;
}

static int reportFailure(bool mcp, bool ready, NSString *code, NSString *appVersion) {
    if (interrupted) return signalExit();
    bool zh = chinese();
    NSString *message;
    if ([code isEqualToString:VersionMismatch]) {
        NSString *running = validVersion(appVersion) ? appVersion : (zh ? @"未知版本" : @"(unknown version)");
        message = [NSString stringWithFormat:zh
            ? @"命令行工具来自 Mioon %@，当前运行的是 %@，请在 Mioon 设置里修复命令行工具。"
            : @"The command-line tool is from Mioon %@. Mioon %@ is running. Repair the command-line tool in Mioon Settings.",
            LauncherVersion, running];
    } else if ([code isEqualToString:@"CLI_AUTH_FAILED"]) {
        message = zh ? @"Mioon 拒绝了命令行工具的连接。" : @"Mioon rejected the command-line connection.";
    } else if ([code isEqualToString:@"SESSION_LIMIT"]) {
        message = zh ? @"Mioon 的命令行连接已满，请稍后再试。" : @"Mioon has reached its command-line session limit. Try again later.";
    } else if ([code isEqualToString:ProtocolError]) {
        message = zh ? @"Mioon 的命令行协议响应无效。" : @"The Mioon command-line protocol response was invalid.";
    } else {
        message = ready
            ? (zh ? @"Mioon 的命令行连接已中断，请重试。" : @"The Mioon command-line connection was lost. Try again.")
            : (zh ? @"Mioon 没在运行，请先打开 Mioon。" : @"Mioon is not running. Open Mioon and try again.");
    }

    if (!mcp) printJSON(@{@"ok": @NO, @"error": @{@"code": code, @"message": message}});
    NSData *diagnostic = [[NSString stringWithFormat:@"%s: %@: %@\n", MIOON_LAUNCHER_COMMAND, code, message] dataUsingEncoding:NSUTF8StringEncoding];
    writeOutput(STDERR_FILENO, diagnostic);
    return mcp && !ready ? 1 : UnavailableExit;
}

static NSDictionary *parseObject(const void *bytes, size_t length) {
    const uint8_t *text = bytes;
    if (length >= 3 && text[0] == 0xef && text[1] == 0xbb && text[2] == 0xbf) return nil;
    if ([[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding] == nil) return nil;
    // NSJSONSerialization also accepts other UTF encodings. NUL cannot appear literally in JSON.
    if (memchr(bytes, '\0', length) != NULL) return nil;
    id value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:bytes length:length] options:0 error:nil];
    return [value isKindOfClass:[NSDictionary class]] ? value : nil;
}

static bool integerInRange(id value, int minimum, int maximum) {
    if (![value isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return false;
    double number = [value doubleValue];
    return number >= minimum && number <= maximum && number == (int)number;
}

static const char *absolutePath(id value) {
    if (![value isKindOfClass:[NSString class]]) return NULL;
    NSData *utf8 = [value dataUsingEncoding:NSUTF8StringEncoding];
    const char *path = [value UTF8String];
    if (path == NULL || path[0] != '/' || utf8.length >= PATH_MAX || strlen(path) != utf8.length) return NULL;
    return path;
}

static bool plainName(const char *name) {
    return name != NULL && *name != '\0' && strcmp(name, ".") != 0 && strcmp(name, "..") != 0 && strchr(name, '/') == NULL;
}

static bool trustedDirectory(struct stat status) {
    if (status.st_uid != geteuid() && status.st_uid != 0) return false;
    if ((status.st_mode & 0022) == 0) return true;
    // The system temporary root can be shared, with the sticky bit protecting owned entries.
    return status.st_uid == 0 && (status.st_mode & S_ISVTX) != 0;
}

static int openDirectory(NSString *path, bool privateDirectory) {
    const char *absolute = absolutePath(path);
    if (absolute == NULL) return -1;
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return -1;
    struct stat status;
    char components[PATH_MAX];
    strlcpy(components, absolute + 1, sizeof(components));
    char *cursor = components;
    for (char *name; (name = strsep(&cursor, "/")) != NULL;) {
        if (*name == '\0') continue;
        if (!plainName(name)) {
            close(fd);
            return -1;
        }
        int next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        close(fd);
        if (next < 0) return -1;
        fd = next;
        if (fstat(fd, &status) != 0 || !trustedDirectory(status)) {
            close(fd);
            return -1;
        }
    }
    if (privateDirectory && (fstat(fd, &status) != 0 || status.st_uid != geteuid() || (status.st_mode & 07777) != 0700)) {
        close(fd);
        return -1;
    }
    return fd;
}

static NSData *readPrivateFile(int directory, const char *name, size_t limit) {
    if (!plainName(name)) return nil;
    int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return nil;
    struct stat status;
    if (fstat(fd, &status) != 0 || !S_ISREG(status.st_mode) || status.st_uid != geteuid()
        || (status.st_mode & 07777) != 0600 || status.st_size <= 0 || (uint64_t)status.st_size > limit) {
        close(fd);
        return nil;
    }
    NSMutableData *data = [NSMutableData dataWithLength:limit + 1];
    uint8_t *buffer = data.mutableBytes;
    size_t length = 0;
    while (length <= limit && !interrupted) {
        ssize_t count = read(fd, buffer + length, limit + 1 - length);
        if (count == 0) break;
        if (count < 0) {
            if (errno == EINTR) continue;
            close(fd);
            return nil;
        }
        length += (size_t)count;
    }
    close(fd);
    if (interrupted || length != (size_t)status.st_size || length > limit) return nil;
    data.length = length;
    return data;
}

static NSString *environmentPath(const char *key) {
    const char *path = getenv(key);
    if (path == NULL || *path == '\0') return nil;
    // Preserve invalid explicit overrides so they fail closed.
    return [NSString stringWithUTF8String:path] ?: @"";
}

static NSString *workingDirectory(void) {
    char *path = getcwd(NULL, 0);
    NSString *directory = path != NULL && strlen(path) <= 4096 ? [NSString stringWithUTF8String:path] : nil;
    free(path);
    return directory;
}

static NSString *descriptorPath(NSString *cwd) {
    NSString *override = environmentPath("MIOON_CONNECTION_FILE");
    NSString *userData = environmentPath("MIOON_CLI_USER_DATA");
    if (override == nil) {
        if (userData == nil) {
            NSString *home = environmentPath("HOME") ?: NSHomeDirectory();
            if (absolutePath(home) == NULL) return nil;
            NSString *support = [home stringByAppendingPathComponent:@"Library/Application Support"];
            userData = [support stringByAppendingPathComponent:AppID];
        }
        if (userData.length == 0) return nil;
        override = [userData stringByAppendingPathComponent:@"mcp-connection.json"];
    }
    if (override.length == 0) return nil;
    if (![override hasPrefix:@"/"] && cwd != nil) override = [cwd stringByAppendingPathComponent:override];
    if (absolutePath(override) == NULL) return nil;
    // Remove lexical dot segments without following directory symlinks.
    NSMutableArray<NSString *> *segments = [NSMutableArray array];
    for (NSString *segment in [override componentsSeparatedByString:@"/"]) {
        if (segment.length == 0 || [segment isEqualToString:@"."]) continue;
        if ([segment isEqualToString:@".."]) [segments removeLastObject];
        else [segments addObject:segment];
    }
    return [@"/" stringByAppendingString:[segments componentsJoinedByString:@"/"]];
}

@interface RuntimeDiscovery : NSObject
@property(nonatomic, copy) NSString *socketPath;
@property(nonatomic, copy) NSString *token;
@property(nonatomic, copy) NSString *appVersion;
@property(nonatomic, copy) NSString *errorCode;
@end

@implementation RuntimeDiscovery
@end

static NSString *readToken(int directory, NSString *path, NSString *parent) {
    if (absolutePath(path) == NULL || ![[path stringByDeletingLastPathComponent] isEqualToString:parent]) return nil;
    NSString *name = path.lastPathComponent;
    if (![path isEqualToString:[parent stringByAppendingPathComponent:name]]) return nil;
    NSData *data = readPrivateFile(directory, name.UTF8String, 65);
    if (data.length != 65) return nil;
    const uint8_t *bytes = data.bytes;
    if (bytes[64] != '\n') return nil;
    for (size_t i = 0; i < 64; i++) {
        if (!((bytes[i] >= '0' && bytes[i] <= '9') || (bytes[i] >= 'a' && bytes[i] <= 'f'))) return nil;
    }
    return [[NSString alloc] initWithBytes:bytes length:64 encoding:NSASCIIStringEncoding];
}

static RuntimeDiscovery *discover(NSString *path) {
    RuntimeDiscovery *result = [RuntimeDiscovery new];
    result.errorCode = Unavailable;
    NSString *parent = path.stringByDeletingLastPathComponent;
    int directory = openDirectory(parent, false);
    if (directory < 0) return result;

    NSData *data = readPrivateFile(directory, path.lastPathComponent.UTF8String, MaxDescriptor);
    NSDictionary *record = data != nil ? parseObject(data.bytes, data.length) : nil;
    id cli = record[@"cli"];
    id pid = record[@"pid"];
    if (!integerInRange(record[@"version"], 1, 1) || !integerInRange(pid, 2, INT_MAX)
        || kill((pid_t)[pid intValue], 0) != 0 || ![cli isKindOfClass:[NSDictionary class]]
        || !validVersion(record[@"appVersion"])) goto done;
    result.appVersion = record[@"appVersion"];
    if (![Channel isEqual:record[@"channel"]] || ![AppID isEqual:record[@"appId"]]
        || !integerInRange(cli[@"protocol"], WireVersion, WireVersion)) {
        result.errorCode = VersionMismatch;
        goto done;
    }
    if (absolutePath(cli[@"socket"]) == NULL) goto done;
    result.token = readToken(directory, cli[@"tokenFile"], parent);
    if (result.token == nil) goto done;
    result.socketPath = cli[@"socket"];
    result.errorCode = nil;

done:
    close(directory);
    return result;
}

static int64_t monotonicMs(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int remainingMs(int64_t deadline) {
    int64_t remaining = deadline - monotonicMs();
    return remaining > 0 ? (int)remaining : 0;
}

static bool waitForSocket(int fd, short events, int wake, int64_t deadline) {
    struct pollfd descriptors[] = {{fd, events, 0}, {wake, POLLIN, 0}};
    for (;;) {
        int timeout = remainingMs(deadline);
        if (timeout == 0 || interrupted) return false;
        int status = poll(descriptors, 2, timeout);
        if (status < 0 && errno == EINTR) continue;
        return status > 0 && !interrupted;
    }
}

static int connectRuntime(NSString *path, int wake, int64_t deadline) {
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    const char *absolute = absolutePath(path);
    if (absolute == NULL || strlen(absolute) >= sizeof(address.sun_path)) return -1;
    NSString *parent = path.stringByDeletingLastPathComponent;
    NSString *name = path.lastPathComponent;
    if (![path isEqualToString:[parent stringByAppendingPathComponent:name]] || !plainName(name.UTF8String)) return -1;
    int directory = openDirectory(parent, true);
    if (directory < 0) return -1;
    struct stat status;
    bool privateSocket = fstatat(directory, name.UTF8String, &status, AT_SYMLINK_NOFOLLOW) == 0
        && S_ISSOCK(status.st_mode) && status.st_uid == geteuid() && (status.st_mode & 07777) == 0600;
    close(directory);
    if (!privateSocket) return -1;

    strlcpy(address.sun_path, absolute, sizeof(address.sun_path));
    address.sun_len = (uint8_t)(offsetof(struct sockaddr_un, sun_path) + strlen(absolute) + 1);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    if (fcntl(fd, F_SETFD, FD_CLOEXEC) < 0 || fcntl(fd, F_SETFL, O_NONBLOCK) < 0) goto fail;
    if (connect(fd, (const struct sockaddr *)&address, address.sun_len) != 0) {
        if (errno != EINPROGRESS || !waitForSocket(fd, POLLOUT, wake, deadline)) goto fail;
        int error = 0;
        socklen_t length = sizeof(error);
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) != 0 || error != 0) goto fail;
    }
    uid_t user;
    gid_t group;
    if (getpeereid(fd, &user, &group) == 0 && user == geteuid()) return fd;
fail:
    close(fd);
    return -1;
}

static void storeLength(uint8_t *bytes, uint32_t length) {
    uint32_t value = htonl(length);
    memcpy(bytes, &value, sizeof(value));
}

static uint32_t loadLength(const uint8_t *bytes) {
    uint32_t value;
    memcpy(&value, bytes, sizeof(value));
    return ntohl(value);
}

static ssize_t socketIO(int fd, bool sending, void *buffer, size_t length, int wake, int64_t deadline) {
    while (!interrupted && remainingMs(deadline) > 0) {
        ssize_t count = sending ? send(fd, buffer, length, 0) : recv(fd, buffer, length, 0);
        if (count >= 0) return count;
        if (errno == EINTR) continue;
        if (errno != EAGAIN && errno != EWOULDBLOCK) break;
        if (!waitForSocket(fd, sending ? POLLOUT : POLLIN, wake, deadline)) break;
    }
    return -1;
}

static bool transferExact(int fd, bool sending, void *buffer, size_t length, int wake, int64_t deadline) {
    for (size_t offset = 0; offset < length;) {
        ssize_t count = socketIO(fd, sending, (uint8_t *)buffer + offset, length - offset, wake, deadline);
        if (count <= 0) return false;
        offset += (size_t)count;
    }
    return true;
}

static bool sendHello(int fd, NSData *hello, int wake, int64_t deadline) {
    uint8_t header[15] = {'M', 'I', 'O', 'O', 'N', 'C', 'L', 'I', 0, 0, WireVersion};
    storeLength(header + 11, (uint32_t)hello.length);
    return transferExact(fd, true, header, sizeof(header), wake, deadline)
        && transferExact(fd, true, (void *)hello.bytes, hello.length, wake, deadline);
}

static NSString *errorCode(NSDictionary *body) {
    id code = body[@"code"];
    if ([Unavailable isEqual:code]) return Unavailable;
    if ([VersionMismatch isEqual:code]) return VersionMismatch;
    if ([@"CLI_AUTH_FAILED" isEqual:code]) return @"CLI_AUTH_FAILED";
    if ([@"SESSION_LIMIT" isEqual:code]) return @"SESSION_LIMIT";
    return ProtocolError;
}

static NSString *handshake(int fd, NSData *hello, int wake, int64_t deadline, NSString **appVersion) {
    bool sent = sendHello(fd, hello, wake, deadline);
    // A saturated host can send ERROR and close before it reads any HELLO bytes.
    uint8_t header[FrameHeader];
    if (!transferExact(fd, false, header, sizeof(header), wake, deadline)) return Unavailable;
    uint32_t length = loadLength(header + 1);
    if (length == 0 || length > MaxPayload || (header[0] != Ready && header[0] != Error)) return ProtocolError;
    NSMutableData *bytes = [NSMutableData dataWithLength:length];
    if (!transferExact(fd, false, bytes.mutableBytes, length, wake, deadline)) return Unavailable;
    NSDictionary *body = parseObject(bytes.bytes, bytes.length);
    if (header[0] == Error) {
        NSString *code = errorCode(body);
        if ([code isEqualToString:VersionMismatch] && validVersion(body[@"appVersion"])) *appVersion = body[@"appVersion"];
        return code;
    }
    if (!sent || !integerInRange(body[@"protocol"], 0, UINT16_MAX)
        || !validVersion(body[@"appVersion"]) || ![body[@"channel"] isKindOfClass:[NSString class]]) return ProtocolError;
    if ([body[@"protocol"] intValue] != WireVersion || ![Channel isEqual:body[@"channel"]]
        || ![LauncherVersion isEqual:body[@"appVersion"]] || ![*appVersion isEqual:body[@"appVersion"]]) {
        *appVersion = body[@"appVersion"];
        return VersionMismatch;
    }
    return nil;
}

struct Outgoing {
    uint8_t bytes[FrameHeader + InputChunk];
    size_t offset, length;
};

static void queueFrame(struct Outgoing *frame, uint8_t type, uint32_t length) {
    frame->bytes[0] = type;
    storeLength(frame->bytes + 1, length);
    frame->offset = 0;
    frame->length = FrameHeader + length;
}

struct Incoming {
    uint8_t header[FrameHeader];
    uint8_t *bytes;
    size_t received, written;
    uint32_t length;
    uint8_t type;
};

static bool transientError(void) {
    return errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK;
}

static NSString *receiveFrame(int fd, struct Incoming *frame) {
    bool atHeader = frame->received < FrameHeader;
    void *buffer = atHeader ? frame->header + frame->received : frame->bytes + frame->received - FrameHeader;
    size_t length = (atHeader ? FrameHeader : FrameHeader + frame->length) - frame->received;
    ssize_t count = recv(fd, buffer, length, 0);
    if (count < 0 && transientError()) return nil;
    if (count <= 0) return Unavailable;
    frame->received += (size_t)count;
    if (atHeader && frame->received == FrameHeader) {
        frame->type = frame->header[0];
        frame->length = loadLength(frame->header + 1);
        if (frame->length == 0 || frame->length > MaxPayload
            || (frame->type != Stdout && frame->type != Stderr && frame->type != Exit && frame->type != Error)) return ProtocolError;
    }
    return nil;
}

static NSString *relay(int fd, int wake, uint8_t *buffer, const int streams[3], int *exitCode, NSString **appVersion) {
    struct Outgoing tx = {0};
    struct Incoming rx = {.bytes = buffer};
    bool eof = false, cancelling = false, cancelQueued = false, sendOpen = true;
    int64_t cancelDeadline = 0;
    for (;;) {
        if (interrupted && !cancelling) {
            cancelling = true;
            cancelDeadline = monotonicMs() + CancelMs;
            // Keep a partial frame intact. An unsent frame can be replaced by CANCEL.
            if (tx.offset == 0) tx.length = 0;
        }
        if (cancelling && tx.offset == tx.length && !cancelQueued) {
            if (!sendOpen) return Unavailable;
            queueFrame(&tx, Cancel, 0);
            cancelQueued = true;
        }
        int timeout = cancelling ? remainingMs(cancelDeadline) : -1;
        if (timeout == 0) return Unavailable;

        // A blocked local output keeps just one received frame in memory. Input
        // can still advance while that output waits for its consumer.
        bool frameReady = rx.received != 0 && rx.received == FrameHeader + rx.length;
        int output = streams[rx.type == Stdout ? STDOUT_FILENO : STDERR_FILENO];
        short socketEvents = (frameReady ? 0 : POLLIN) | (sendOpen && tx.offset != tx.length ? POLLOUT : 0);
        bool readInput = sendOpen && !eof && !cancelling && tx.offset == tx.length;
        struct pollfd descriptors[] = {
            {socketEvents == 0 ? -1 : fd, socketEvents, 0},
            {readInput ? streams[STDIN_FILENO] : -1, POLLIN, 0},
            {frameReady ? output : -1, POLLOUT, 0},
            {cancelling ? -1 : wake, POLLIN, 0},
        };
        int status = poll(descriptors, 4, timeout);
        if (status < 0 && errno == EINTR) continue;
        if (status <= 0) return Unavailable;
        if (descriptors[3].revents != 0) continue;
        if (descriptors[2].revents != 0) {
            ssize_t count = write(output, rx.bytes + rx.written, rx.length - rx.written);
            if (count > 0) {
                rx.written += (size_t)count;
                if (rx.written == rx.length) rx = (struct Incoming){.bytes = buffer};
            } else if (count == 0 || !transientError()) return Unavailable;
        }
        if (descriptors[1].revents != 0) {
            ssize_t count = read(streams[STDIN_FILENO], tx.bytes + FrameHeader, InputChunk);
            if (count > 0) queueFrame(&tx, Stdin, (uint32_t)count);
            else if (count == 0 || errno == EBADF) {
                eof = true;
                queueFrame(&tx, StdinEOF, 0);
            } else if (!transientError()) return Unavailable;
        }
        if (tx.offset != tx.length && (descriptors[0].revents & (POLLOUT | POLLERR | POLLHUP | POLLNVAL))) {
            ssize_t count = send(fd, tx.bytes + tx.offset, tx.length - tx.offset, 0);
            if (count > 0) tx.offset += (size_t)count;
            // The host can close its read side while its EXIT is still buffered.
            else if (count == 0 || !transientError()) sendOpen = false;
        }
        if (!frameReady && (descriptors[0].revents & (POLLIN | POLLERR | POLLHUP | POLLNVAL))) {
            NSString *failure = receiveFrame(fd, &rx);
            if (failure != nil) return failure;
            if (rx.received != FrameHeader + rx.length || (rx.type != Exit && rx.type != Error)) continue;
            NSDictionary *body = parseObject(rx.bytes, rx.length);
            if (rx.type == Error) {
                if (validVersion(body[@"appVersion"])) *appVersion = body[@"appVersion"];
                return errorCode(body);
            }
            if (!integerInRange(body[@"code"], 0, 255)
                || (body[@"signal"] != nil && ![body[@"signal"] isKindOfClass:[NSString class]])) return ProtocolError;
            *exitCode = [body[@"code"] intValue];
            return nil;
        }
    }
}

static int reopenTerminal(int fd, int flags, struct stat original) {
    char name[PATH_MAX];
    if (ttyname_r(fd, name, sizeof(name)) != 0) return -1;
    int independent = open(name, (flags & O_ACCMODE) | O_NONBLOCK | O_NOCTTY | O_NOFOLLOW | O_CLOEXEC);
    if (independent < 0) return -1;
    struct stat status;
    if (fstat(independent, &status) == 0 && status.st_dev == original.st_dev
        && status.st_ino == original.st_ino && status.st_rdev == original.st_rdev) return independent;
    close(independent);
    return -1;
}

static NSString *runRelay(int fd, int wake, int *exitCode, NSString **appVersion) {
    int flags[] = {fcntl(STDIN_FILENO, F_GETFL), fcntl(STDOUT_FILENO, F_GETFL), fcntl(STDERR_FILENO, F_GETFL)};
    int streams[] = {STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO};
    bool restore[] = {false, false, false};
    uint8_t *bytes = malloc(MaxPayload);
    if (bytes == NULL) return Unavailable;
    NSString *error = nil;
    for (int i = 0; i < 3; i++) {
        struct stat status;
        if (flags[i] < 0 || fstat(i, &status) != 0) {
            error = Unavailable;
            break;
        }
        if ((flags[i] & O_NONBLOCK) != 0 || S_ISREG(status.st_mode)) continue;
        // Reopen terminals so the shell and other jobs retain their descriptor flags.
        int terminal = S_ISCHR(status.st_mode) ? reopenTerminal(i, flags[i], status) : -1;
        if (terminal >= 0) {
            streams[i] = terminal;
        } else if (fcntl(i, F_SETFL, flags[i] | O_NONBLOCK) == 0) {
            restore[i] = true;
        } else {
            error = Unavailable;
            break;
        }
    }
    if (error == nil) error = relay(fd, wake, bytes, streams, exitCode, appVersion);
    for (int i = 0; i < 3; i++) {
        if (streams[i] != i) close(streams[i]);
        if (restore[i]) fcntl(i, F_SETFL, flags[i]);
    }
    free(bytes);
    return error;
}

static NSArray<NSString *> *arguments(int argc, char **argv, bool mcp) {
    int first = mcp ? 2 : 1;
    if (argc - first > 256) return nil;
    NSMutableArray<NSString *> *args = [NSMutableArray arrayWithCapacity:(NSUInteger)(argc - first)];
    for (int i = first; i < argc; i++) {
        NSString *arg = [NSString stringWithUTF8String:argv[i]];
        if (arg == nil) return nil;
        [args addObject:arg];
    }
    return args;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        bool mcp = argc > 1 && strcmp(argv[1], "mcp") == 0;
        int wake[2];
        if (!ensureStandardDescriptors() || !setupSignals(wake)) return reportFailure(mcp, false, Unavailable, nil);
        if (argc == 2 && strcmp(argv[1], "--version") == 0) {
            if (printJSON(@{@"ok": @YES, @"data": @{@"name": @"mioon", @"version": LauncherVersion}})) return 0;
            return interrupted ? signalExit() : UnavailableExit;
        }
        NSArray<NSString *> *args = arguments(argc, argv, mcp);
        if (args == nil) return reportFailure(mcp, false, ProtocolError, nil);
        NSString *cwd = workingDirectory();
        RuntimeDiscovery *runtime = discover(descriptorPath(cwd));
        if (runtime.errorCode != nil) return reportFailure(mcp, false, runtime.errorCode, runtime.appVersion);

        NSMutableDictionary *fields = [@{
            @"protocol": @(WireVersion), @"channel": Channel, @"launcherVersion": LauncherVersion,
            @"appVersion": runtime.appVersion, @"token": runtime.token, @"role": mcp ? @"mcp" : @"cli", @"argv": args,
        } mutableCopy];
        if (cwd != nil) fields[@"cwd"] = cwd;
        NSData *hello = [NSJSONSerialization dataWithJSONObject:fields options:0 error:nil];
        if (hello.length == 0 || hello.length > MaxPayload) return reportFailure(mcp, false, ProtocolError, runtime.appVersion);

        int64_t deadline = monotonicMs() + HandshakeMs;
        int fd = connectRuntime(runtime.socketPath, wake[0], deadline);
        if (fd < 0) return reportFailure(mcp, false, Unavailable, runtime.appVersion);
        NSString *appVersion = runtime.appVersion;
        NSString *failure = handshake(fd, hello, wake[0], deadline, &appVersion);
        bool ready = failure == nil;
        int exitCode = 0;
        if (ready) failure = runRelay(fd, wake[0], &exitCode, &appVersion);
        close(fd);
        if (failure != nil) return reportFailure(mcp, ready, failure, appVersion);
        return interrupted ? signalExit() : exitCode;
    }
}
