# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# This Source Code Form is "Incompatible With Secondary Licenses", as
# defined by the Mozilla Public License, v. 2.0.

package Bugzilla::Memcached;

use 5.10.1;
use strict;
use warnings;

use Bugzilla::Logging;
use Log::Log4perl qw(:easy);
use Bugzilla::Error;
use Scalar::Util qw(blessed);
use List::Util qw(sum);
use Bugzilla::Util qw(trim);
use URI::Escape;
use Encode;
use Sys::Syslog qw(:DEFAULT);

# memcached keys have a maximum length of 250 bytes
use constant MAX_KEY_LENGTH    => 250;
use constant RATE_LIMIT_PREFIX => "rate:";

*new = \&_new;

sub _new {
  my $invocant = shift;
  my $class    = ref($invocant) || $invocant;
  my $self     = {};

  # always return an object to simplify calling code when memcached is
  # disabled.
  my $servers = Bugzilla->localconfig->memcached_servers;
  if (Bugzilla->feature('memcached') && $servers) {
    $self->{namespace} = Bugzilla->localconfig->memcached_namespace;
    TRACE("connecting servers: $servers, namespace: $self->{namespace}");
    $self->{memcached} = Cache::Memcached::Fast->new({
      servers         => [_parse_memcached_server_list($servers)],
      namespace       => $self->{namespace},
      max_size        => 1024 * 1024 * 4,
      max_failures    => 3,
      failure_timeout => 60,
      io_timeout      => 0.2,
      connect_timeout => 0.2,
    });
    my $versions = $self->{memcached}->server_versions;
    if (keys %$versions) {

# this is needed to ensure forked processes don't start out with a connected memcached socket.
      $self->{memcached}->disconnect_all;
    }
    else {
      WARN("No memcached servers");
    }
  }
  else {
    TRACE("memcached feature is not enabled");
  }
  return bless($self, $class);
}

sub _parse_memcached_server_list {
  my ($server_list) = @_;
  my @servers = split(/[, ]+/, trim($server_list));

  return map { /:[0-9]+$/s ? $_ : "$_:11211" } @servers;
}

sub enabled {
  return $_[0]->{memcached} ? 1 : 0;
}

sub set {
  my ($self, $args) = @_;
  return unless $self->{memcached};

  # { key => $key, value => $value }
  if (exists $args->{key}) {
    $self->_set($args->{key}, $args->{value});
  }

  # { table => $table, id => $id, name => $name, data => $data }
  elsif (exists $args->{table} && exists $args->{id} && exists $args->{name}) {

    # For caching of Bugzilla::Object, we have to be able to clear the
    # cached values when given either the object's id or name.
    my ($table, $id, $name, $data) = @$args{qw(table id name data)};
    $self->_set("$table.id.$id", $data);
    if (defined $name) {
      $self->_set("$table.name_id.$name", $id);
      $self->_set("$table.id_name.$id",   $name);
    }
  }

  else {
    ThrowCodeError('params_required',
      {function => "Bugzilla::Memcached::set", params => ['key', 'table']});
  }
}

sub get {
  my ($self, $args) = @_;
  return unless $self->{memcached};

  # { key => $key }
  if (exists $args->{key}) {
    return $self->_get($args->{key});
  }

  # { table => $table, id => $id }
  elsif (exists $args->{table} && exists $args->{id}) {
    my ($table, $id) = @$args{qw(table id)};
    return $self->_get("$table.id.$id");
  }

  # { table => $table, name => $name }
  elsif (exists $args->{table} && exists $args->{name}) {
    my ($table, $name) = @$args{qw(table name)};
    return unless my $id = $self->_get("$table.name_id.$name");
    return $self->_get("$table.id.$id");
  }

  else {
    ThrowCodeError('params_required',
      {function => "Bugzilla::Memcached::get", params => ['key', 'table']});
  }
}

sub set_config {
  my ($self, $args) = @_;
  return unless $self->{memcached};

  if (exists $args->{key}) {
    return $self->_set($self->_config_prefix . '.' . $args->{key}, $args->{data});
  }
  else {
    ThrowCodeError('params_required',
      {function => "Bugzilla::Memcached::set_config", params => ['key']});
  }
}

sub get_config {
  my ($self, $args) = @_;
  return unless $self->{memcached};

  if (exists $args->{key}) {
    return $self->_get($self->_config_prefix . '.' . $args->{key});
  }
  else {
    ThrowCodeError('params_required',
      {function => "Bugzilla::Memcached::get_config", params => ['key']});
  }
}

sub set_params {
  my ($self, $params) = @_;
  return unless $self->{memcached};

  return $self->_set($self->_params_prefix . ".params", $params);
}

sub get_params {
  my ($self) = @_;
  return unless $self->{memcached};

  return $self->_get($self->_params_prefix . ".params");
}

sub clear_params {
  my ($self, $args) = @_;
  return unless $self->{memcached};
  $self->_inc_prefix("params");
}

sub set_data {
  my ($self, $args) = @_;
  return unless $self->{memcached};

  if (exists $args->{key}) {
    my $key        = $self->_resource_prefix . '.' . $args->{key};
    my $expires_in = $args->{expires_in};

    return $self->_set($key, {
      value   => $args->{value},
      expires => $expires_in ? time() + $expires_in : 0,
    });
  }
  else {
    ThrowCodeError('params_required',
      {function => "Bugzilla::Memcached::set_data", params => ['key']});
  }
}

sub get_data {
  my ($self, $args) = @_;
  return unless $self->{memcached};

  if (exists $args->{key}) {
    my $key   = $self->_resource_prefix . '.' . $args->{key};
    my $cache = $self->_get($key);

    return undef unless $cache;
    return $cache->{value} if $cache->{expires} == 0 || $cache->{expires} > time();

    $self->_delete($key);
    return undef;
  }
  else {
    ThrowCodeError('params_required',
      {function => "Bugzilla::Memcached::get_data", params => ['key']});
  }
}

sub set_bloomfilter {
  my ($self, $args) = @_;
  return unless $self->{memcached};
  if (exists $args->{name}) {
    return $self->_set($self->_bloomfilter_prefix . '.' . $args->{name},
      $args->{filter});
  }
  else {
    ThrowCodeError('params_required',
      {function => "Bugzilla::Memcached::set_bloomfilter", params => ['name']});
  }
}

sub get_bloomfilter {
  my ($self, $args) = @_;
  return unless $self->{memcached};
  if (exists $args->{name}) {
    return $self->_get($self->_bloomfilter_prefix . '.' . $args->{name});
  }
  else {
    ThrowCodeError('params_required',
      {function => "Bugzilla::Memcached::set_bloomfilter", params => ['name']});
  }
}

sub clear_bloomfilter {
  my ($self, $args) = @_;
  return unless $self->{memcached};
  if ($args && exists $args->{name}) {
    $self->_delete($self->_config_prefix . '.' . $args->{name});
  }
  else {
    $self->_inc_prefix("bloomfilter");
  }
}

sub clear {
  my ($self, $args) = @_;
  return unless $self->{memcached};

  # { key => $key }
  if (exists $args->{key}) {
    $self->_delete($args->{key});
  }

  # { table => $table, id => $id }
  elsif (exists $args->{table} && exists $args->{id}) {
    my ($table, $id) = @$args{qw(table id)};
    my $name = $self->_get("$table.id_name.$id");
    $self->_delete("$table.id.$id");
    $self->_delete("$table.name_id.$name") if defined $name;
    $self->_delete("$table.id_name.$id");
  }

  # { table => $table, name => $name }
  elsif (exists $args->{table} && exists $args->{name}) {
    my ($table, $name) = @$args{qw(table name)};
    return unless my $id = $self->_get("$table.name_id.$name");
    $self->_delete("$table.id.$id");
    $self->_delete("$table.name_id.$name");
    $self->_delete("$table.id_name.$id");
  }

  else {
    ThrowCodeError('params_required',
      {function => "Bugzilla::Memcached::clear", params => ['key', 'table']});
  }
}

sub should_rate_limit {
  my ($self, $name, $rate_max, $rate_seconds, $tries) = @_;
  my $prefix    = RATE_LIMIT_PREFIX . $name . ':';
  my $memcached = $self->{memcached};

  return 0 unless $name;
  return 0 unless $memcached;

  $tries //= 4;

  for my $try (1 .. $tries) {
    my $now = time;
    my ($key, @keys) = map { $prefix . ($now - $_) } 0 .. $rate_seconds;
    $memcached->add($key, 0, $rate_seconds + 1);
    my $tokens = $memcached->get_multi(@keys);
    my $cas    = $memcached->gets($key);
    $tokens->{$key} = $cas->[1]++;
    return 1 if sum(values %$tokens) >= $rate_max;
    return 0 if $memcached->cas($key, @$cas, $rate_seconds + 1);
    WARN("retry for $prefix (try $try of $tries)");
  }
  return 0;
}

sub clear_all {
  my ($self) = @_;
  return unless $self->{memcached};
  $self->_inc_prefix("global");
}

sub clear_config {
  my ($self, $args) = @_;
  return unless $self->{memcached};
  if ($args && exists $args->{key}) {
    $self->_delete($self->_config_prefix . '.' . $args->{key});
  }
  else {
    $self->_inc_prefix("config");
  }
}

# in order to clear all our keys, we add a prefix to all our keys.  when we
# need to "clear" all current keys, we increment the prefix.
sub _prefix {
  my ($self, $name) = @_;

  # we don't want to change prefixes in the middle of a request
  $name .= "/" . Bugzilla->VERSION;
  my $request_cache     = Bugzilla->request_cache;
  my $request_cache_key = "memcached_prefix_$name";
  if (!$request_cache->{$request_cache_key}) {
    my $memcached = $self->{memcached};
    my $prefix    = $memcached->get($name);
    if (!$prefix) {
      $prefix = time();
      if (!$memcached->add($name, $prefix)) {

        # if this failed, either another process set the prefix, or
        # memcached is down.  assume we lost the race, and get the new
        # value.  if that fails, memcached is down so use a dummy
        # prefix for this request.
        $prefix = $memcached->get($name) || 0;
      }
    }
    $request_cache->{$request_cache_key} = $prefix;
  }
  return $request_cache->{$request_cache_key};
}

sub _inc_prefix {
  my ($self, $name) = @_;
  my $memcached = $self->{memcached};
  $name .= "/" . Bugzilla->VERSION;
  if (!$memcached->incr($name, 1)) {
    $memcached->add($name, time());
  }
  delete Bugzilla->request_cache->{"memcached_prefix_$name"};

  # BMO - log that we've wiped the cache
  TRACE("$name cache cleared");
}

sub _global_prefix {
  return $_[0]->_prefix("global");
}

sub _config_prefix {
  return $_[0]->_prefix("config");
}

sub _params_prefix {
  return $_[0]->_prefix("params");
}

sub _resource_prefix {
  return $_[0]->_prefix("resource");
}

sub _bloomfilter_prefix {
  return $_[0]->_prefix("bloomfilter");
}

sub _encode_key {
  my ($self, $key) = @_;
  $key = $self->_global_prefix . '.' . uri_escape_utf8($key);
  return length($self->{namespace} . $key) > MAX_KEY_LENGTH ? undef : $key;
}

sub _set {
  my ($self, $key, $value) = @_;
  if (blessed($value)) {

    # we don't support blessed objects
    ThrowCodeError('param_invalid',
      {function => "Bugzilla::Memcached::set", param => "value"});
  }

  my $enc_key = $self->_encode_key($key) or return;
  TRACE("set $enc_key");
  return $self->{memcached}->set($enc_key, $value);
}

sub _get {
  my ($self, $key) = @_;

  my $enc_key = $self->_encode_key($key) or return;
  my $val = $self->{memcached}->get($enc_key);
  TRACE("get $enc_key: " . (defined $val ? "HIT" : "MISS"));
  return $val;
}

sub _delete {
  my ($self, $key) = @_;
  $key = $self->_encode_key($key) or return;
  return $self->{memcached}->delete($key);
}

1;

__END__

=head1 NAME

Bugzilla::Memcached - Interface between Bugzilla and Memcached.

=head1 SYNOPSIS

 use Bugzilla;

 my $memcached = Bugzilla->memcached;

 # grab data from the cache. there is no need to check if memcached is
 # available or enabled.
 my $data = $memcached->get({ key => 'data_key' });
 if (!defined $data) {
     # not in cache, generate the data and populate the cache for next time
     $data = some_long_process();
     $memcached->set({ key => 'data_key', value => $data });
 }
 # do something with $data

 # updating the profiles table directly shouldn't be attempted unless you know
 # what you're doing. if you do update a table directly, you need to clear that
 # object from memcached.
 $dbh->do("UPDATE profiles SET request_count=10 WHERE login_name=?", undef, $login);
 $memcached->clear({ table => 'profiles', name => $login });

=head1 DESCRIPTION

If Memcached is installed and configured, Bugzilla can use it to cache data
across requests and between webheads. Unlike the request and process caches,
only scalars, hashrefs, and arrayrefs can be stored in Memcached.

Memcached integration is only required for large installations of Bugzilla --
if you have multiple webheads then configuring Memcache is recommended.

L<Bugzilla::Memcached> provides an interface to a Memcached server/servers, with
the ability to get, set, or clear entries from the cache.

The stored value must be an unblessed hashref, unblessed array ref, or a
scalar.

All values are stored in the Memcached systems using the prefix configured with
the C<memcached_namespace> parameter, as well as an additional prefix managed
by this class to allow all values to be cleared when C<checksetup.pl> is
executed.

Do not create an instance of this object directly, instead use
L<Bugzilla-E<gt>memcached()|Bugzilla/memcached>.

=head1 METHODS

=over

=item C<enabled>

Returns true if Memcached support is available and enabled.

=back

=head2 Setting

Adds a value to Memcached.

=over

=item C<set({ key =E<gt> $key, value =E<gt> $value })>

Adds the C<value> using the specific C<key>.

=item C<set({ table =E<gt> $table, id =E<gt> $id, name =E<gt> $name, data =E<gt> $data })>

Adds the C<data> using a keys generated from the C<table>, C<id>, and C<name>.
All three parameters must be provided, however C<name> can be provided but set
to C<undef>.

This is a convenience method which allows cached data to be later retrieved by
specifying the C<table> and either the C<id> or C<name>.

=item C<set_config({ key =E<gt> $key, data =E<gt> $data })>

Adds the C<data> using the C<key> while identifying the data as part of
Bugzilla's configuration (such as fields, products, components, groups, etc).
Values set with C<set_config> are automatically cleared when changes are made
to Bugzilla's configuration.

=item C<set_data({ key =E<gt> $key, value =E<gt> $value, expires_in =E<gt> $expires_in })>

Adds the C<value> using the C<key> while identifying the generic data such as
decoded JSON retrieved from a remote API endpoint. Optionally, data retention
period can be specified with C<expires_in> in seconds. If it's not set, the
stored data never expires.

=back

=head2 Getting

Retrieves a value from Memcached.  Returns C<undef> if no matching values were
found in the cache.

=over

=item C<get({ key =E<gt> $key })>

Return C<value> with the specified C<key>.

=item C<get({ table =E<gt> $table, id =E<gt> $id })>

Return C<value> with the specified C<table> and C<id>.

=item C<get({ table =E<gt> $table, name =E<gt> $name })>

Return C<value> with the specified C<table> and C<name>.

=item C<get_config({ key =E<gt> $key })>

Return C<value> with the specified C<key> from the configuration cache.  See
C<set_config> for more information.

=item C<get_data({ key =E<gt> $key })>

Return C<value> with the specified C<key> from the generic data cache.  See
C<set_data> for more information.

=back

=head2 Clearing

Removes the matching value from Memcached.

=over

=item C<clear({ key =E<gt> $key })>

Removes C<value> with the specified C<key>.

=item C<clear({ table =E<gt> $table, id =E<gt> $id })>

Removes C<value> with the specified C<table> and C<id>, as well as the
corresponding C<table> and C<name> entry.

=item C<clear({ table =E<gt> $table, name =E<gt> $name })>

Removes C<value> with the specified C<table> and C<name>, as well as the
corresponding C<table> and C<id> entry.

=item C<clear_config({ key =E<gt> $key })>

Remove C<value> with the specified C<key> from the configuration cache.  See
C<set_config> for more information.

=item C<clear_config>

Removes all configuration related values from the cache.  See C<set_config> for
more information.

=item C<clear_all>

Removes all values from the cache.

=back

=head1 Bugzilla::Object CACHE

The main driver for Memcached integration is to allow L<Bugzilla::Object> based
objects to be automatically cached in Memcache. This is enabled on a
per-package basis by setting the C<USE_MEMCACHED> constant to any true value.

The current implementation is an opt-in (USE_MEMCACHED is false by default),
however this will change to opt-out once further testing has been completed
(USE_MEMCACHED will be true by default).

=head1 DIRECT DATABASE UPDATES

If an object is cached and the database is updated directly (instead of via
C<$object-E<gt>update()>), then it's possible for the data in the cache to be
out of sync with the database.

As an example let's consider an extension which adds a timestamp field
C<last_activity_ts> to the profiles table and user object which contains the
user's last activity.  If the extension were to call C<$user-E<gt>update()>,
then an audit entry would be created for each change to the C<last_activity_ts>
field, which is undesirable.

To remedy this, the extension updates the table directly.  It's critical with
Memcached that it then clears the cache:

 $dbh->do("UPDATE profiles SET last_activity_ts=? WHERE userid=?",
          undef, $timestamp, $user_id);
 Bugzilla->memcached->clear({ table => 'profiles', id => $user_id });
