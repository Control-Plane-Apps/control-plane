Pod::Spec.new do |s|
  s.name           = 'CPPushActions'
  s.version        = '1.0.0'
  s.summary        = 'Runs Control Plane notification buttons without opening the app.'
  s.description    = 'Answer, Complete and Snooze from an iPhone notification, handled natively.'
  s.author         = 'Control Plane'
  s.homepage       = 'https://controlplane.work'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoNotifications'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{swift}'
end
