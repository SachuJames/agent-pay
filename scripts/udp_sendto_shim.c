/*
 * udp_sendto_shim.c
 *
 * LD_PRELOAD shim for sandboxes whose seccomp profile blocks the sendto/
 * sendmsg/sendmmsg syscalls when a destination address is supplied, while
 * still permitting connect()+send() on UDP sockets.
 *
 * It transparently rewrites:
 *   sendto(fd, buf, len, flags, dest, addrlen)
 *     -> connect(fd, dest, addrlen); send(fd, buf, len, flags)
 *   sendmsg(fd, &msg, flags)  with msg.msg_name != NULL
 *     -> connect(); gather iovecs into one datagram; send()
 *   sendmmsg(fd, vec, vlen, flags)
 *     -> per-message equivalent of sendmsg
 *
 * Only applied to SOCK_DGRAM sockets; everything else passes through.
 * Per-fd mutexes keep connect()+send() pairs from interleaving across
 * threads sharing a socket.
 *
 * Build: gcc -shared -fPIC -o udp_shim.so udp_sendto_shim.c -ldl -lpthread
 * Use:   LD_PRELOAD=/path/to/udp_shim.so <program>
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/syscall.h>

#define MAX_FDS 1024

static ssize_t (*real_sendto)(int, const void *, size_t, int,
                              const struct sockaddr *, socklen_t) = NULL;
static ssize_t (*real_send)(int, const void *, size_t, int) = NULL;
static ssize_t (*real_sendmsg)(int, const struct msghdr *, int) = NULL;
static int (*real_sendmmsg)(int, struct mmsghdr *, unsigned int, int) = NULL;
static int (*real_connect)(int, const struct sockaddr *, socklen_t) = NULL;

static pthread_mutex_t fd_locks[MAX_FDS];
static pthread_once_t init_once = PTHREAD_ONCE_INIT;

static void do_init(void) {
    real_sendto = dlsym(RTLD_NEXT, "sendto");
    real_send = dlsym(RTLD_NEXT, "send");
    real_sendmsg = dlsym(RTLD_NEXT, "sendmsg");
    real_sendmmsg = dlsym(RTLD_NEXT, "sendmmsg");
    real_connect = dlsym(RTLD_NEXT, "connect");
    for (int i = 0; i < MAX_FDS; i++) {
        pthread_mutex_init(&fd_locks[i], NULL);
    }
}

static pthread_mutex_t *lock_for(int fd) {
    if (fd < 0 || fd >= MAX_FDS) {
        return NULL;
    }
    return &fd_locks[fd];
}

/* Debug: count interceptions when UDP_SHIM_DEBUG is set. */
static void debug_count(const char *fn) {
    const char *path = getenv("UDP_SHIM_DEBUG");
    if (!path) {
        return;
    }
    /* Best-effort append; ignore errors. */
    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd >= 0) {
        char buf[64];
        int n = snprintf(buf, sizeof(buf), "%s\n", fn);
        /* Use raw syscall to avoid recursion into our own interposers. */
        syscall(SYS_write, fd, buf, (size_t)n);
        syscall(SYS_close, fd);
    }
}

/* True if fd is a datagram (UDP) socket. */
static int is_dgram(int fd) {
    int type = 0;
    socklen_t len = sizeof(type);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &len) != 0) {
        return 0;
    }
    return type == SOCK_DGRAM;
}

/* connect() to dest then send() the buffer; caller must hold the fd lock.
 * The socket is disconnected (AF_UNSPEC) afterwards so it keeps receiving
 * datagrams from any peer; without this, a connected UDP socket would drop
 * packets arriving from other peers. */
static ssize_t connect_and_send(int fd, const struct sockaddr *dest,
                                socklen_t addrlen, const void *buf,
                                size_t len, int flags) {
    if (dest != NULL) {
        if (real_connect(fd, dest, addrlen) != 0) {
            return -1;
        }
    }
    ssize_t r = real_send(fd, buf, len, flags);
    if (dest != NULL) {
        struct sockaddr unspec;
        memset(&unspec, 0, sizeof(unspec));
        unspec.sa_family = AF_UNSPEC;
        /* Best effort: restore unconnected state even if send failed. */
        real_connect(fd, &unspec, sizeof(unspec));
    }
    return r;
}

ssize_t sendto(int sockfd, const void *buf, size_t len, int flags,
               const struct sockaddr *dest_addr, socklen_t addrlen) {
    pthread_once(&init_once, do_init);
    debug_count("sendto");
    if (!is_dgram(sockfd)) {
        return real_sendto(sockfd, buf, len, flags, dest_addr, addrlen);
    }
    pthread_mutex_t *l = lock_for(sockfd);
    if (l) {
        pthread_mutex_lock(l);
    }
    ssize_t r = connect_and_send(sockfd, dest_addr, addrlen, buf, len, flags);
    if (l) {
        pthread_mutex_unlock(l);
    }
    return r;
}

ssize_t sendmsg(int sockfd, const struct msghdr *msg, int flags) {
    pthread_once(&init_once, do_init);
    debug_count("sendmsg");
    if (!is_dgram(sockfd) || msg->msg_name == NULL) {
        return real_sendmsg(sockfd, msg, flags);
    }
    /* Gather iovecs into a single datagram to preserve boundaries. */
    size_t total = 0;
    for (size_t i = 0; i < msg->msg_iovlen; i++) {
        total += msg->msg_iov[i].iov_len;
    }
    char *flat = malloc(total ? total : 1);
    if (!flat) {
        errno = ENOMEM;
        return -1;
    }
    size_t off = 0;
    for (size_t i = 0; i < msg->msg_iovlen; i++) {
        memcpy(flat + off, msg->msg_iov[i].iov_base, msg->msg_iov[i].iov_len);
        off += msg->msg_iov[i].iov_len;
    }
    pthread_mutex_t *l = lock_for(sockfd);
    if (l) {
        pthread_mutex_lock(l);
    }
    ssize_t r = connect_and_send(sockfd, (const struct sockaddr *)msg->msg_name,
                                 msg->msg_namelen, flat, total, flags);
    if (l) {
        pthread_mutex_unlock(l);
    }
    free(flat);
    return r;
}

int sendmmsg(int sockfd, struct mmsghdr *msgvec, unsigned int vlen, int flags) {
    pthread_once(&init_once, do_init);
    debug_count("sendmmsg");
    if (!is_dgram(sockfd)) {
        return real_sendmmsg(sockfd, msgvec, vlen, flags);
    }
    unsigned int sent = 0;
    for (unsigned int i = 0; i < vlen; i++) {
        ssize_t r = sendmsg(sockfd, &msgvec[i].msg_hdr, flags);
        if (r < 0) {
            if (sent == 0) {
                return -1;
            }
            break;
        }
        msgvec[i].msg_len = (unsigned int)r;
        sent++;
    }
    return (int)sent;
}
